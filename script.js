(() => {
  const STORAGE_KEY = 'estudai.v1';
  const USER_MARKER = 'estudai.lastUserId';
  const DEFAULT_FOLDERS = [
    { id: 'poemas', name: 'Poemas', icon: '✎', builtIn: true },
    { id: 'ideias', name: 'Ideias', icon: '✧', builtIn: true },
    { id: 'projetos', name: 'Projetos', icon: '◈', builtIn: true },
    { id: 'anotacoes', name: 'Anotações', icon: '▤', builtIn: true },
    { id: 'arquivos', name: 'Arquivos', icon: '▧', builtIn: true }
  ];
  const KIND_INFO = {
    text: { label: 'Texto', icon: '▤' }, poem: { label: 'Poema', icon: '✎' },
    idea: { label: 'Ideia', icon: '✧' }, project: { label: 'Projeto', icon: '◈' }, file: { label: 'Arquivo', icon: '▧' }, folder: { label: 'Pasta de trabalho', icon: '▣' }
  };
  const MAX_FILE_SIZE = 50 * 1024 * 1024;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const byId = id => document.getElementById(id);
  const uid = () => crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  function stripPostgresNulls(value) {
    if (typeof value === 'string') return value.replace(/\u0000/g, '');
    if (Array.isArray(value)) return value.map(stripPostgresNulls);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/\u0000/g, ''), stripPostgresNulls(item)]));
    }
    return value;
  }
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const supabaseClient = window.supabase?.createClient && window.ESTUDAI_SUPABASE?.url && window.ESTUDAI_SUPABASE?.publishableKey
    ? window.supabase.createClient(window.ESTUDAI_SUPABASE.url, window.ESTUDAI_SUPABASE.publishableKey)
    : null;

  const emptyData = () => ({ folders: DEFAULT_FOLDERS.map(folder => ({ ...folder })), entries: [] });
  let data = normalizeData(readLocalData());
  let currentUser = null;
  let cloudReady = false;
  let loadingUserId = null;
  let cloudSaveTimer = null;
  let authBusy = false;
  let activeFolder = 'all';
  let activeKind = 'all';
  let activeEntryId = null;
  let pendingBackup = null;
  let toastTimer;

  function readLocalData() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch { return null; }
  }

  function normalizeData(raw) {
    raw = stripPostgresNulls(raw);
    const normalized = emptyData();
    if (raw && Array.isArray(raw.entries)) {
      const extraFolders = Array.isArray(raw.folders) ? raw.folders : [];
      normalized.folders = [
        ...DEFAULT_FOLDERS.map(folder => ({ ...folder, ...(extraFolders.find(item => item.id === folder.id) || {}) })),
        ...extraFolders.filter(folder => folder?.id && !DEFAULT_FOLDERS.some(item => item.id === folder.id)).map(folder => ({ id: String(folder.id), name: String(folder.name || 'Coleção'), icon: String(folder.icon || '▣'), builtIn: false }))
      ];
      normalized.entries = raw.entries.filter(entry => entry && entry.id).map(entry => ({
        id: String(entry.id), title: String(entry.title || 'Sem título'), folderId: normalized.folders.some(folder => folder.id === entry.folderId) ? entry.folderId : 'anotacoes',
        kind: Object.hasOwn(KIND_INFO, entry.kind) ? entry.kind : 'text', text: String(entry.text || ''),
        tags: Array.isArray(entry.tags) ? entry.tags.map(String).slice(0, 20) : [], favorite: Boolean(entry.favorite),
        createdAt: entry.createdAt || new Date().toISOString(), updatedAt: entry.updatedAt || entry.createdAt || new Date().toISOString(),
        file: entry.file && typeof entry.file === 'object' ? { path: String(entry.file.path || ''), name: String(entry.file.name || 'arquivo'), size: Number(entry.file.size) || 0, type: String(entry.file.type || 'application/octet-stream') } : null,
        files: Array.isArray(entry.files) ? entry.files.filter(file => file && file.path).map(file => ({ path: String(file.path), name: String(file.name || 'arquivo'), relativePath: String(file.relativePath || file.name || 'arquivo'), size: Number(file.size) || 0, type: String(file.type || 'application/octet-stream') })) : []
      }));
      return normalized;
    }

    // Migrate the earlier study planner into an Anotações collection.
    if (raw && Array.isArray(raw.subjects)) {
      const now = new Date().toISOString();
      normalized.entries = raw.subjects.map(subject => {
        const sections = [];
        if (subject.description) sections.push(subject.description);
        (subject.topics || []).forEach(topic => {
          sections.push(`## ${topic.name}${topic.description ? `\n${topic.description}` : ''}`);
          (topic.questions || []).forEach(question => sections.push(`Pergunta: ${question.prompt}\nResposta: ${question.answer}`));
        });
        return { id: uid(), title: subject.name || 'Matéria antiga', folderId: 'anotacoes', kind: 'text', text: sections.join('\n\n'), tags: ['material antigo'], favorite: false, createdAt: now, updatedAt: now, file: null };
      });
    }
    return normalized;
  }

  const findFolder = id => data.folders.find(folder => folder.id === id);
  const findEntry = id => data.entries.find(entry => entry.id === id);
  const folderCount = id => data.entries.filter(entry => entry.folderId === id).length;

  function persist() {
    try {
      data = stripPostgresNulls(data);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      scheduleCloudSave();
      return true;
    } catch (error) {
      showToast('Não consegui salvar. Confira o espaço disponível no navegador.');
      return false;
    }
  }

  function scheduleCloudSave() {
    if (!currentUser || !cloudReady || !supabaseClient) return;
    const userId = currentUser.id;
    const snapshot = stripPostgresNulls(JSON.parse(JSON.stringify(data)));
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(async () => {
      if (!currentUser || currentUser.id !== userId || !cloudReady) return;
      const { error } = await supabaseClient.from('pif_data').upsert({ user_id: userId, data: snapshot, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) {
        showToast('Não consegui sincronizar agora. Confira sua conexão.');
        updateStorageStatus('Falha na sincronização');
      } else updateStorageStatus('Salvo na nuvem');
    }, 350);
  }

  function updateStorageStatus(message) { if (byId('storageStatus')) byId('storageStatus').textContent = message; }

  function updateAuthView() {
    const button = byId('authButton');
    if (!button) return;
    if (currentUser) {
      button.textContent = 'Sair';
      byId('userAvatar').textContent = (currentUser.email || 'P').slice(0, 1).toUpperCase();
      byId('userAvatar').title = currentUser.email || 'Conta conectada';
      updateStorageStatus(cloudReady ? 'Sincronizado na nuvem' : 'Conectando à nuvem…');
    } else {
      button.textContent = 'Entrar';
      byId('userAvatar').textContent = 'P';
      byId('userAvatar').title = 'Seu perfil';
      updateStorageStatus('Salvo neste navegador');
    }
  }

  async function handleSignedInUser(user) {
    if (!user || !supabaseClient) { currentUser = null; cloudReady = false; updateAuthView(); return; }
    if (loadingUserId === user.id || (currentUser?.id === user.id && cloudReady)) return;
    loadingUserId = user.id;
    currentUser = user;
    cloudReady = false;
    updateAuthView();

    const previousUserId = localStorage.getItem(USER_MARKER);
    if (previousUserId && previousUserId !== user.id) data = emptyData();
    const localHadEntries = data.entries.length > 0 || (!Array.isArray(readLocalData()?.entries) && Array.isArray(readLocalData()?.subjects));

    const { data: row, error } = await supabaseClient.from('pif_data').select('data').eq('user_id', user.id).maybeSingle();
    if (error) {
      updateStorageStatus('Confira a conexão do banco');
      showToast('Não consegui carregar a biblioteca da nuvem.');
      loadingUserId = null;
      return;
    }

    if (row?.data) {
      const remoteRaw = row.data;
      const remoteData = normalizeData(remoteRaw);
      const needsMigration = !Array.isArray(remoteRaw.entries);
      let uploadedLocal = false;
      const localDiffersFromCloud = JSON.stringify(data) !== JSON.stringify(remoteData);
      if (localHadEntries && localDiffersFromCloud) {
        const useLocal = window.confirm('A cópia deste aparelho tem conteúdo diferente da nuvem. OK mantém e envia a cópia deste aparelho (incluindo alterações ainda não sincronizadas); Cancelar carrega a versão da nuvem.');
        if (useLocal) {
          data = stripPostgresNulls(data);
          const { error: uploadError } = await supabaseClient.from('pif_data').upsert({ user_id: user.id, data, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
          if (uploadError) { showToast('Não consegui enviar o conteúdo local para a nuvem.'); loadingUserId = null; return; }
          uploadedLocal = true;
        } else data = remoteData;
      } else data = remoteData;
      if (needsMigration && !uploadedLocal) {
        const { error: migrationError } = await supabaseClient.from('pif_data').upsert({ user_id: user.id, data, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
        if (migrationError) { showToast('Não consegui atualizar seus dados antigos no banco.'); loadingUserId = null; return; }
      }
    } else {
      const { error: uploadError } = await supabaseClient.from('pif_data').upsert({ user_id: user.id, data, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (uploadError) { showToast('Não consegui preparar sua biblioteca na nuvem.'); loadingUserId = null; return; }
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    localStorage.setItem(USER_MARKER, user.id);
    cloudReady = true;
    loadingUserId = null;
    render(); updateAuthView();
    showToast('Sua biblioteca foi carregada.');
  }

  function initializeAuth() {
    if (!supabaseClient) { updateAuthView(); return; }
    supabaseClient.auth.onAuthStateChange((_event, authSession) => { if (authSession?.user) setTimeout(() => handleSignedInUser(authSession.user), 0); });
    supabaseClient.auth.getSession().then(({ data: result }) => result.session?.user ? handleSignedInUser(result.session.user) : updateAuthView()).catch(() => updateAuthView());
  }

  function openAuthModal() {
    if (!supabaseClient) { showToast('A conexão com a nuvem ainda não está configurada.'); return; }
    byId('authForm').reset();
    byId('authDescription').textContent = 'Entre ou crie uma conta para sincronizar sua biblioteca.';
    byId('createAccount').hidden = false;
    openModal(byId('authModal'));
  }

  async function signIn() {
    if (authBusy) return;
    const email = byId('authEmail').value.trim(), password = byId('authPassword').value;
    if (!byId('authEmail').reportValidity() || !password) return;
    authBusy = true;
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    authBusy = false;
    if (error) { showToast('Não consegui entrar. Confira o e-mail e a senha.'); return; }
    closeModals();
  }

  async function createAccount() {
    if (authBusy) return;
    const email = byId('authEmail').value.trim(), password = byId('authPassword').value;
    if (!byId('authEmail').reportValidity() || password.length < 6) {
      if (password.length < 6) { byId('authPassword').setCustomValidity('Use pelo menos 6 caracteres.'); byId('authPassword').reportValidity(); byId('authPassword').setCustomValidity(''); }
      return;
    }
    authBusy = true;
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    const { data: result, error } = await supabaseClient.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
    authBusy = false;
    if (error) { showToast(error.message); return; }
    if (result.session) closeModals();
    else { byId('authDescription').textContent = 'Conta criada! Confirme pelo link enviado ao seu e-mail e depois entre.'; byId('createAccount').hidden = true; showToast('Confira seu e-mail para confirmar a conta.'); }
  }

  async function signOut() {
    if (!currentUser || !supabaseClient) return;
    const { error } = await supabaseClient.auth.signOut();
    if (error) { showToast('Não consegui sair da conta. Tente novamente.'); return; }
    currentUser = null; cloudReady = false; activeEntryId = null; data = emptyData();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    activeFolder = 'all'; render(); updateAuthView(); showToast('Você saiu. Sua biblioteca continua na nuvem.');
  }

  function exportBackup() {
    const backup = { format: 'pif-vault-backup', version: 2, exportedAt: new Date().toISOString(), data };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `pif-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    showToast('Backup da sua biblioteca baixado.');
  }

  function mergeData(current, incoming) {
    const folders = [...current.folders];
    incoming.folders.forEach(folder => { const at = folders.findIndex(item => item.id === folder.id); if (at >= 0) folders[at] = folder; else folders.push(folder); });
    const entries = [...current.entries];
    incoming.entries.forEach(entry => { const at = entries.findIndex(item => item.id === entry.id); if (at >= 0) entries[at] = entry; else entries.push(entry); });
    return { folders, entries };
  }

  async function importBackup(file) {
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      const source = ['pif-vault-backup', 'pif-backup', 'estudai-backup'].includes(backup?.format) ? backup.data : backup;
      if (!source || (!Array.isArray(source.entries) && !Array.isArray(source.subjects))) throw new Error('invalid-backup');
      const restored = normalizeData(source);
      if (data.entries.length) { pendingBackup = restored; openModal(byId('backupChoiceModal')); }
      else applyBackup(restored, true);
    } catch (error) { showToast('Não consegui abrir esse backup do Vinho & Verso.'); }
    finally { byId('backupFile').value = ''; }
  }

  function applyBackup(restored, replace) {
    data = replace ? restored : mergeData(data, restored);
    if (!persist()) return;
    closeModals(); render();
    showToast(`${restored.entries.length} ${restored.entries.length === 1 ? 'item importado' : 'itens importados'} do backup.`);
    pendingBackup = null;
  }

  function render() {
    renderCounts(); renderCustomFolders(); renderHeader(); renderEntries();
  }

  function renderCounts() {
    byId('countAll').textContent = data.entries.length;
    byId('countPoemas').textContent = folderCount('poemas');
    byId('countIdeias').textContent = folderCount('ideias');
    byId('countProjetos').textContent = folderCount('projetos');
    byId('countAnotacoes').textContent = folderCount('anotacoes');
    byId('countArquivos').textContent = folderCount('arquivos');
    byId('countFavorites').textContent = data.entries.filter(entry => entry.favorite).length;
    byId('statItems').textContent = data.entries.length;
    byId('statFolders').textContent = data.folders.length;
    byId('statFavorites').textContent = data.entries.filter(entry => entry.favorite).length;
    byId('poemTotal').textContent = folderCount('poemas');
  }

  function renderCustomFolders() {
    const custom = data.folders.filter(folder => !folder.builtIn);
    byId('customFolders').innerHTML = custom.length ? custom.map(folder => `<div class="custom-folder-wrap"><button class="custom-folder ${activeFolder === folder.id ? 'active' : ''}" data-folder="${escapeHTML(folder.id)}"><span>${escapeHTML(folder.icon || '▣')}</span><span>${escapeHTML(folder.name)}</span><span class="folder-count">${folderCount(folder.id)}</span></button><button class="custom-folder-delete" data-delete-folder="${escapeHTML(folder.id)}" aria-label="Apagar coleção ${escapeHTML(folder.name)}" title="Apagar coleção">×</button></div>`).join('') : '<div class="folder-empty">Crie uma coleção sua com o +</div>';
    $$('[data-folder]', byId('customFolders')).forEach(button => button.addEventListener('click', () => selectFolder(button.dataset.folder)));
    $$('[data-delete-folder]', byId('customFolders')).forEach(button => button.addEventListener('click', event => { event.stopPropagation(); deleteFolder(button.dataset.deleteFolder); }));
  }

  function renderHeader() {
    const folder = findFolder(activeFolder);
    const title = activeFolder === 'all' ? 'Tudo' : activeFolder === 'favorites' ? 'Favoritos' : folder?.name || 'Tudo';
    const descriptions = {
      all: 'Poemas, ideias, projetos e arquivos — cada coisa no seu lugar.',
      poemas: 'Seus versos, rascunhos e poemas completos.', ideias: 'Pensamentos soltos que merecem ser guardados.',
      projetos: 'Planos, trabalhos e coisas que você está criando.', anotacoes: 'Textos e notas que você quer encontrar depois.',
      arquivos: 'Seus arquivos pessoais, organizados em um só lugar.', favorites: 'Acesso rápido às coisas que você mais gosta.'
    };
    byId('currentCrumb').textContent = title;
    const poemsView = activeFolder === 'poemas';
    const categoryData = {
      anotacoes: { symbol: '▤', eyebrow: 'CADERNO PESSOAL', heading: 'Textos para guardar e revisitar.', description: 'Rascunhos, pensamentos e escritos completos, reunidos num caderno só seu.', button: 'Escrever texto', count: 'text' },
      ideias: { symbol: '✧', eyebrow: 'MURAL DE IDEIAS', heading: 'Toda ideia pode virar algo.', description: 'Reúna inspirações, frases soltas e projetos que ainda estão começando.', button: 'Anotar ideia', count: 'idea' },
      projetos: { symbol: '◈', eyebrow: 'SUA OFICINA', heading: 'Criações em andamento.', description: 'Organize planos, referências e materiais dos seus projetos em um só lugar.', button: 'Criar projeto', count: 'project' },
      arquivos: { symbol: '▧', eyebrow: 'ARQUIVO PESSOAL', heading: 'Seus arquivos, sempre à mão.', description: 'Guarde documentos e anexos com nome, coleção e etiquetas para encontrar depois.', button: 'Enviar arquivo', count: 'file' }
    };
    const customData = folder && !folder.builtIn ? { symbol: folder.icon || '▣', eyebrow: 'SUA COLEÇÃO', heading: folder.name, description: `Tudo o que você reuniu em ${folder.name}.`, button: 'Adicionar item', count: 'all' } : null;
    const showcase = categoryData[activeFolder] || customData;
    const showCategory = !poemsView && Boolean(showcase);
    byId('libraryView').classList.toggle('poems-view', poemsView);
    byId('libraryView').classList.toggle('collection-view', showCategory);
    byId('libraryView').dataset.section = activeFolder;
    byId('poemIntro').hidden = !poemsView;
    byId('categoryShowcase').hidden = !showCategory;
    if (showcase) {
      byId('showcaseSymbol').textContent = showcase.symbol;
      byId('showcaseEyebrow').textContent = showcase.eyebrow;
      byId('showcaseHeading').textContent = showcase.heading;
      byId('showcaseDescription').textContent = showcase.description;
      byId('showcaseButtonLabel').textContent = showcase.button;
      const count = showcase.count === 'all' ? folderCount(activeFolder) : data.entries.filter(entry => (entry.kind === showcase.count || (showcase.count === 'file' && entry.kind === 'folder')) && (activeFolder === 'all' || entry.folderId === activeFolder)).length;
      byId('showcaseCount').textContent = count;
      byId('showcaseCountLabel').textContent = count === 1 ? (showcase.count === 'file' ? 'item salvo' : 'item guardado') : (showcase.count === 'file' ? 'itens salvos' : 'itens guardados');
    }
    byId('statsGrid').hidden = poemsView || showCategory;
    byId('filterRow').hidden = poemsView;
    $$('.content-tab').forEach(button => {
      const selected = button.dataset.viewfolder === activeFolder;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-current', selected ? 'page' : 'false');
    });
    byId('pageTitle').innerHTML = `${escapeHTML(title === 'Tudo' ? 'Tudo que é seu' : title)}<span class="title-dot">.</span>`;
    byId('pageDescription').textContent = descriptions[activeFolder] || `Tudo que você guardou em ${title}.`;
    byId('sectionEyebrow').textContent = activeFolder === 'all' ? 'SUA BIBLIOTECA' : 'COLEÇÃO';
    byId('sectionTitle').textContent = activeFolder === 'all' ? 'Adicionados recentemente' : activeFolder === 'favorites' ? 'Seus destaques' : `Dentro de ${title}`;
    $$('.nav-link').forEach(button => button.classList.toggle('active', button.dataset.folder === activeFolder));
  }

  function kindText(entry) { return KIND_INFO[entry.kind]?.label || 'Anotação'; }
  function entryDate(entry) {
    try { return new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(entry.updatedAt)); }
    catch { return ''; }
  }

  function filteredEntries() {
    const query = byId('searchInput').value.trim().toLocaleLowerCase('pt-BR');
    const sort = byId('sortSelect').value;
    const categoryKind = { poemas: 'poem', anotacoes: 'text', ideias: 'idea', projetos: 'project', arquivos: 'file' }[activeFolder];
    let entries = data.entries.filter(entry => {
      const inFolder = activeFolder === 'all' || (activeFolder === 'favorites' ? entry.favorite : entry.folderId === activeFolder);
      const inCategory = !categoryKind || entry.kind === categoryKind || (activeFolder === 'arquivos' && entry.kind === 'folder');
      const inKind = activeKind === 'all' || (activeKind === 'file' ? entry.kind === 'file' || entry.kind === 'folder' : entry.kind !== 'file' && entry.kind !== 'folder');
      const folderNames = (entry.files || []).map(file => `${file.name} ${file.relativePath}`).join(' ');
      const haystack = `${entry.title} ${entry.text} ${entry.tags.join(' ')} ${entry.file?.name || ''} ${folderNames}`.toLocaleLowerCase('pt-BR');
      return inFolder && inCategory && inKind && (!query || haystack.includes(query));
    });
    entries.sort((a, b) => sort === 'oldest' ? new Date(a.createdAt) - new Date(b.createdAt) : sort === 'az' ? a.title.localeCompare(b.title, 'pt-BR') : new Date(b.updatedAt) - new Date(a.updatedAt));
    return entries;
  }

  function renderEntries() {
    const entries = filteredEntries();
    const grid = byId('entryGrid');
    const query = byId('searchInput').value.trim();
    if (!entries.length) {
      const header = query ? 'Nada encontrado por aqui.' : activeFolder === 'favorites' ? 'Seus favoritos aparecem aqui.' : 'Esse espaço está esperando por você.';
      const copy = query ? 'Tente buscar por outra palavra ou etiqueta.' : 'Guarde um poema, uma ideia, um projeto ou qualquer coisa que queira encontrar depois.';
      grid.innerHTML = `<div class="empty-state"><span class="empty-state-icon">${query ? '⌕' : '✦'}</span><h3>${header}</h3><p>${copy}</p>${!query && activeFolder !== 'favorites' ? '<button class="primary-button" id="emptyAdd">＋ Guardar algo</button>' : ''}</div>`;
      $('#emptyAdd', grid)?.addEventListener('click', () => openEntryModal());
      return;
    }
    grid.innerHTML = entries.map(entry => {
      const folder = findFolder(entry.folderId);
      const info = KIND_INFO[entry.kind] || KIND_INFO.text;
      const excerpt = entry.kind === 'file' ? `<div class="entry-file-line"><span>▧</span><span>${escapeHTML(entry.file?.name || 'Arquivo anexado')} · ${formatSize(entry.file?.size || 0)}</span></div>` : entry.kind === 'folder' ? `<div class="entry-file-line"><span>▣</span><span>${entry.files.length} arquivos · ${escapeHTML(entry.files[0]?.relativePath || 'Pasta de trabalho')}</span></div>` : `<p class="entry-excerpt">${escapeHTML(entry.text || 'Sem conteúdo ainda.')}</p>`;
      const tags = entry.tags.length ? `<div class="entry-tags">${entry.tags.slice(0, 3).map(tag => `<span class="tag">${escapeHTML(tag)}</span>`).join('')}</div>` : '';
      const cardClass = { poem: 'poem-card', text: 'text-card', idea: 'idea-card', project: 'project-card', file: 'file-card', folder: 'file-card folder-card' }[entry.kind] || 'text-card';
      return `<article class="entry-card ${cardClass}" data-open-entry="${escapeHTML(entry.id)}" tabindex="0"><div class="entry-card-top"><div class="entry-type" data-kind="${escapeHTML(entry.kind)}"><span class="entry-type-icon">${info.icon}</span>${info.label}</div><button class="favorite-button ${entry.favorite ? 'active' : ''}" data-favorite="${escapeHTML(entry.id)}" aria-label="${entry.favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}" title="Favorito">${entry.favorite ? '♥' : '♡'}</button></div><h3>${escapeHTML(entry.title)}</h3>${excerpt}${tags}<div class="entry-card-foot"><span class="entry-folder-label">${escapeHTML(folder?.name || 'Anotações')}</span><span>${entryDate(entry)}</span></div></article>`;
    }).join('');
    $$('[data-open-entry]', grid).forEach(card => {
      card.addEventListener('click', event => { if (!event.target.closest('[data-favorite]')) openEntry(card.dataset.openEntry); });
      card.addEventListener('keydown', event => { if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openEntry(card.dataset.openEntry); } });
    });
    $$('[data-favorite]', grid).forEach(button => button.addEventListener('click', event => { event.stopPropagation(); toggleFavorite(button.dataset.favorite); }));
  }

  function selectFolder(folderId) {
    activeFolder = folderId;
    activeKind = 'all';
    $$('.filter-chip').forEach(button => button.classList.toggle('active', button.dataset.kind === 'all'));
    renderCustomFolders(); renderHeader(); renderEntries();
  }

  $$('.content-tab').forEach(button => button.addEventListener('click', () => selectFolder(button.dataset.viewfolder)));
  byId('newPoem').addEventListener('click', () => openEntryModal());
  byId('newCategoryEntry').addEventListener('click', () => openEntryModal());
  document.addEventListener('contextmenu', event => {
    if (event.target.closest('.entry-card, .nav-link, .custom-folder, .content-tab')) event.preventDefault();
  });

  function openModal(dialog) { if (!dialog.open) dialog.showModal(); }
  function closeModals() { $$('dialog[open]').forEach(dialog => dialog.close()); }
  function showToast(message) {
    const toast = byId('toast'); toast.textContent = message; toast.classList.add('visible');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('visible'), 2700);
  }

  function fillFolderOptions(selectedId) {
    byId('entryFolder').innerHTML = data.folders.map(folder => `<option value="${escapeHTML(folder.id)}" ${folder.id === selectedId ? 'selected' : ''}>${escapeHTML(folder.name)}</option>`).join('');
  }

  function openEntryModal(entry = null) {
    byId('entryForm').reset();
    byId('entryId').value = entry?.id || '';
    byId('entryModalTitle').innerHTML = entry ? 'Editar item<span class="title-dot">.</span>' : 'Um espaço para isso<span class="title-dot">.</span>';
    byId('entryTitle').value = entry?.title || '';
    byId('entryTags').value = entry?.tags?.join(', ') || '';
    byId('entryContent').value = entry?.text || '';
    byId('textImportFile').value = '';
    byId('entryKind').value = entry?.kind || (activeFolder === 'poemas' ? 'poem' : activeFolder === 'ideias' ? 'idea' : activeFolder === 'projetos' ? 'project' : activeFolder === 'arquivos' ? 'file' : 'text');
    fillFolderOptions(entry?.folderId || (findFolder(activeFolder) ? activeFolder : 'anotacoes'));
    byId('entryFile').value = '';
    byId('entryFolderFiles').value = '';
    updateKindFields(Boolean((entry?.kind === 'file' && entry.file) || (entry?.kind === 'folder' && entry.files?.length)));
    if (entry?.file) byId('fileHelp').textContent = `Anexado: ${entry.file.name}. Selecione outro para substituir.`;
    if (entry?.files?.length) byId('fileHelp').textContent = `Pasta atual com ${entry.files.length} arquivos. Selecione outra pasta para substituir.`;
    openModal(byId('entryModal')); setTimeout(() => byId('entryTitle').focus(), 40);
  }

  function updateKindFields(hasExistingFile = false) {
    const kind = byId('entryKind').value;
    const isFile = kind === 'file';
    const isFolder = kind === 'folder';
    const isPoem = byId('entryKind').value === 'poem';
    byId('textContentField').hidden = isFile || isFolder;
    byId('fileContentField').hidden = !isFile && !isFolder;
    byId('singleFileField').hidden = !isFile;
    byId('folderFilesField').hidden = !isFolder;
    byId('poemGuidance').hidden = !isPoem;
    byId('contentLabel').textContent = isPoem ? 'Seu poema' : byId('entryKind').value === 'text' ? 'Seu texto' : 'Seu conteúdo';
    byId('entryContent').placeholder = isPoem
      ? 'Escreva seus versos aqui…\n\nSepare as estrofes com uma linha em branco.'
      : byId('entryKind').value === 'text' ? 'Escreva ou cole seu texto aqui…' : 'Escreva ou cole seu conteúdo aqui…';
    byId('entryContent').classList.toggle('poem-editor', isPoem);
    byId('entryFile').required = isFile && !hasExistingFile;
    byId('entryFolderFiles').required = isFolder && !hasExistingFile;
    if (isFile && !hasExistingFile) byId('fileHelp').textContent = 'Arquivos ficam privados na sua conta. Limite: 50 MB por arquivo.';
    if (!isFile) byId('entryFile').required = false;
    if (!isFolder) byId('entryFolderFiles').required = false;
  }

  function parseTags(value) { return [...new Set(value.split(',').map(tag => tag.trim()).filter(Boolean))].slice(0, 20); }
  async function importTextFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { showToast('Esse texto passa do limite de 2 MB.'); event.target.value = ''; return; }
    try {
      const text = await file.text();
      if (!text.trim()) { showToast('Esse arquivo está vazio.'); return; }
      byId('entryContent').value = text;
      if (!byId('entryTitle').value.trim()) byId('entryTitle').value = file.name.replace(/\.(txt|md)$/i, '');
      showToast('Texto importado. Revise e guarde quando estiver pronto.');
    } catch {
      showToast('Não consegui ler esse arquivo. Tente um .txt ou .md.');
    } finally { event.target.value = ''; }
  }
  function safeFileName(name) { return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-100) || 'arquivo'; }
  function safeRelativePath(path) {
    return path.split(/[\\/]+/).filter(part => part && part !== '.' && part !== '..').map(safeFileName).join('/');
  }

  async function saveEntry(event) {
    event.preventDefault();
    const id = byId('entryId').value;
    const previous = id ? findEntry(id) : null;
    const title = byId('entryTitle').value.trim();
    const kind = byId('entryKind').value;
    const selectedFile = byId('entryFile').files?.[0] || null;
    const selectedFolderFiles = [...(byId('entryFolderFiles').files || [])];
    const isUpload = kind === 'file' || kind === 'folder';
    if (isUpload && !currentUser) { showToast('Entre na sua conta para guardar arquivos na nuvem.'); closeModals(); openAuthModal(); return; }
    if (selectedFile && selectedFile.size > MAX_FILE_SIZE) { showToast('Esse arquivo passa do limite de 50 MB.'); return; }
    if (selectedFolderFiles.length > 250) { showToast('A pasta pode ter no máximo 250 arquivos.'); return; }
    const folderBytes = selectedFolderFiles.reduce((total, file) => total + file.size, 0);
    if (selectedFolderFiles.some(file => file.size > MAX_FILE_SIZE)) { showToast('Há um arquivo na pasta que passa do limite de 50 MB.'); return; }
    if (folderBytes > 200 * 1024 * 1024) { showToast('A pasta passa do limite total de 200 MB.'); return; }
    if (kind === 'folder' && !selectedFolderFiles.length && !previous?.files?.length) { showToast('Escolha uma pasta com arquivos para guardar.'); return; }

    const entryId = previous?.id || uid();
    const uploadedPaths = [];
    const saveButton = byId('saveEntry');
    const originalButtonHTML = saveButton.innerHTML;
    let fileMeta = kind === 'file' ? previous?.file || null : null;
    let filesMeta = kind === 'folder' ? previous?.files || [] : [];
    saveButton.disabled = true;
    try {
      if (kind === 'file' && selectedFile) {
        const path = `${currentUser.id}/${entryId}/${uid()}-${safeFileName(selectedFile.name)}`;
        const { error } = await supabaseClient.storage.from('pif-files').upload(path, selectedFile, { upsert: false, contentType: selectedFile.type || 'application/octet-stream' });
        if (error) { showToast('Não consegui enviar o arquivo. Confira o armazenamento e tente novamente.'); return; }
        uploadedPaths.push(path);
        fileMeta = { path, name: selectedFile.name, size: selectedFile.size, type: selectedFile.type || 'application/octet-stream' };
      }
      if (kind === 'folder' && selectedFolderFiles.length) {
        const batchId = uid();
        const firstPath = selectedFolderFiles[0].webkitRelativePath || selectedFolderFiles[0].name;
        const rootName = firstPath.includes('/') ? firstPath.split('/')[0] : title;
        filesMeta = [];
        for (let index = 0; index < selectedFolderFiles.length; index += 1) {
          const file = selectedFolderFiles[index];
          const rawPath = file.webkitRelativePath || file.name;
          const parts = rawPath.split(/[\\/]+/).filter(part => part && part !== '.' && part !== '..');
          const relativePath = file.webkitRelativePath && parts.length > 1 ? `${safeFileName(rootName)}/${parts.slice(1).map(safeFileName).join('/')}` : `${safeFileName(title)}/${safeFileName(file.name)}`;
          const storagePath = `${currentUser.id}/${entryId}/${batchId}/${safeRelativePath(rawPath)}`;
          saveButton.textContent = `Enviando ${index + 1} de ${selectedFolderFiles.length}…`;
          const { error } = await supabaseClient.storage.from('pif-files').upload(storagePath, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
          if (error) {
            if (uploadedPaths.length) await supabaseClient.storage.from('pif-files').remove(uploadedPaths);
            showToast(`Falha ao enviar ${file.name}. Confira o armazenamento e tente novamente.`);
            return;
          }
          uploadedPaths.push(storagePath);
          filesMeta.push({ path: storagePath, name: file.name, relativePath, size: file.size, type: file.type || 'application/octet-stream' });
        }
      }
    } catch {
      if (uploadedPaths.length) await supabaseClient.storage.from('pif-files').remove(uploadedPaths);
      showToast('O envio falhou. Confira sua conexão e tente guardar novamente.');
      return;
    } finally {
      saveButton.disabled = false;
      saveButton.innerHTML = originalButtonHTML;
    }

    const now = new Date().toISOString();
    const entry = {
      id: entryId, title,
      folderId: isUpload && byId('entryFolder').value === 'arquivos' ? 'arquivos' : byId('entryFolder').value,
      kind, text: isUpload ? '' : byId('entryContent').value,
      tags: parseTags(byId('entryTags').value), favorite: previous?.favorite || false,
      createdAt: previous?.createdAt || now, updatedAt: now, file: fileMeta, files: filesMeta
    };
    const replacedPaths = [previous?.file?.path, ...(previous?.files || []).map(file => file.path)].filter(Boolean).filter(path => !uploadedPaths.includes(path));
    const previousData = JSON.parse(JSON.stringify(data));
    if (previous) data.entries[data.entries.findIndex(item => item.id === id)] = entry;
    else data.entries.unshift(entry);
    if (!persist()) {
      data = previousData;
      if (uploadedPaths.length) await supabaseClient.storage.from('pif-files').remove(uploadedPaths);
      render();
      return;
    }
    if (replacedPaths.length && currentUser && supabaseClient) {
      const { error } = await supabaseClient.storage.from('pif-files').remove(replacedPaths);
      if (error) showToast('O item foi salvo, mas alguns arquivos antigos não puderam ser removidos.');
    }
    closeModals(); render(); showToast(previous ? 'Alterações guardadas.' : 'Item guardado na sua biblioteca.');
  }

  function openEntry(id) {
    const entry = findEntry(id); if (!entry) return;
    activeEntryId = id;
    const folder = findFolder(entry.folderId), info = KIND_INFO[entry.kind] || KIND_INFO.text;
    byId('detailMeta').textContent = `${folder?.name || 'Coleção'} · ${info.label} · ${entryDate(entry)}`;
    byId('detailTitle').textContent = entry.title;
    byId('detailTags').innerHTML = entry.tags.map(tag => `<span class="tag">${escapeHTML(tag)}</span>`).join('');
    byId('detailContent').hidden = entry.kind === 'file' || entry.kind === 'folder';
    byId('detailContent').textContent = entry.text;
    byId('detailContent').classList.toggle('poem-detail', entry.kind === 'poem');
    byId('detailFile').hidden = entry.kind !== 'file' && entry.kind !== 'folder';
    byId('detailFile').innerHTML = entry.kind === 'folder'
      ? `<strong>${entry.files.length} arquivos nesta pasta</strong><ul class="stored-file-list">${entry.files.map(file => `<li><span>${escapeHTML(file.relativePath)} <small>${formatSize(file.size)}</small></span></li>`).join('')}</ul>`
      : entry.kind === 'file' ? `${escapeHTML(entry.file?.name || 'Arquivo')} · ${formatSize(entry.file?.size || 0)}` : '';
    byId('downloadEntry').hidden = entry.kind !== 'file' && entry.kind !== 'folder';
    byId('downloadEntry').innerHTML = entry.kind === 'folder' ? 'Baixar pasta (.zip) <span>↓</span>' : 'Baixar arquivo <span>↓</span>';
    openModal(byId('detailModal'));
  }

  function formatSize(size) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function downloadEntry() {
    const entry = findEntry(activeEntryId);
    if (!entry || !currentUser) { showToast('Entre na sua conta para baixar esse conteúdo.'); return; }
    if (entry.kind === 'folder') {
      if (!window.JSZip) { showToast('O compactador não carregou. Atualize a página e tente novamente.'); return; }
      const zip = new window.JSZip();
      for (const storedFile of entry.files || []) {
        const { data: file, error } = await supabaseClient.storage.from('pif-files').download(storedFile.path);
        if (error) { showToast(`Não consegui baixar ${storedFile.name}. Confira sua conexão.`); return; }
        zip.file(storedFile.relativePath || storedFile.name, file);
      }
      try {
        const archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        triggerDownload(archive, `${safeFileName(entry.title)}.zip`);
      } catch { showToast('Não consegui montar o ZIP desta pasta.'); }
      return;
    }
    if (!entry.file?.path) { showToast('Esse item não tem um arquivo disponível para baixar.'); return; }
    const { data: file, error } = await supabaseClient.storage.from('pif-files').download(entry.file.path);
    if (error) { showToast('Não consegui baixar o arquivo. Confira sua conexão.'); return; }
    triggerDownload(file, entry.file.name);
  }

  function triggerDownload(file, filename) {
    const url = URL.createObjectURL(file), link = document.createElement('a');
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function deleteEntry() {
    const entry = findEntry(activeEntryId);
    if (!entry || !window.confirm(`Apagar “${entry.title}”?`)) return;
    const storedPaths = [entry.file?.path, ...(entry.files || []).map(file => file.path)].filter(Boolean);
    if (storedPaths.length && currentUser) {
      const { error } = await supabaseClient.storage.from('pif-files').remove(storedPaths);
      if (error) { showToast('Não consegui remover o arquivo da nuvem. Tente novamente.'); return; }
    }
    const previousData = JSON.parse(JSON.stringify(data));
    data.entries = data.entries.filter(item => item.id !== entry.id);
    if (!persist()) { data = previousData; render(); return; }
    closeModals(); activeEntryId = null; render(); showToast('Item apagado.');
  }

  function toggleFavorite(id) {
    const entry = findEntry(id); if (!entry) return;
    entry.favorite = !entry.favorite; entry.updatedAt = new Date().toISOString(); persist(); render();
    showToast(entry.favorite ? 'Adicionado aos favoritos.' : 'Removido dos favoritos.');
  }

  function openFolderModal() { byId('folderForm').reset(); openModal(byId('folderModal')); setTimeout(() => byId('folderName').focus(), 40); }
  function createFolder(event) {
    event.preventDefault();
    const name = byId('folderName').value.trim();
    if (!name) return;
    if (data.folders.some(folder => folder.name.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'))) { showToast('Já existe uma coleção com esse nome.'); return; }
    const folder = { id: `custom-${uid()}`, name, icon: '▣', builtIn: false };
    data.folders.push(folder); persist(); closeModals(); render(); selectFolder(folder.id); showToast('Coleção criada.');
  }

  function deleteFolder(id) {
    const folder = findFolder(id); if (!folder || folder.builtIn) return;
    const count = folderCount(id);
    if (!window.confirm(`Apagar a coleção “${folder.name}”? ${count ? `${count} ${count === 1 ? 'item será movido' : 'itens serão movidos'} para Anotações.` : ''}`)) return;
    const previousData = JSON.parse(JSON.stringify(data));
    data.entries.forEach(entry => { if (entry.folderId === id) { entry.folderId = 'anotacoes'; entry.updatedAt = new Date().toISOString(); } });
    data.folders = data.folders.filter(item => item.id !== id);
    if (activeFolder === id) activeFolder = 'all';
    if (!persist()) { data = previousData; render(); return; }
    render(); showToast('Coleção removida. Os itens foram movidos para Anotações.');
  }

  function openImportPicker() { byId('backupFile').click(); }
  function closeSidebar() { byId('sidebar').classList.remove('open'); }

  // Navigation and filters
  $$('[data-folder]').forEach(button => button.addEventListener('click', () => selectFolder(button.dataset.folder)));
  $$('.filter-chip').forEach(button => button.addEventListener('click', () => {
    activeKind = button.dataset.kind; $$('.filter-chip').forEach(chip => chip.classList.toggle('active', chip === button)); renderEntries();
  }));
  byId('searchInput').addEventListener('input', renderEntries);
  byId('sortSelect').addEventListener('change', renderEntries);
  document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); byId('searchInput').focus(); } if (event.key === 'Escape') closeSidebar(); });
  byId('menuToggle').addEventListener('click', () => byId('sidebar').classList.toggle('open'));
  byId('newEntry').addEventListener('click', () => openEntryModal());
  byId('addFolder').addEventListener('click', openFolderModal);
  byId('entryKind').addEventListener('change', () => {
    const kind = byId('entryKind').value;
    const automaticFolder = { poem: 'poemas', idea: 'ideias', project: 'projetos', file: 'arquivos', folder: 'arquivos' }[kind];
    if (automaticFolder && findFolder(automaticFolder)) byId('entryFolder').value = automaticFolder;
    const editing = findEntry(byId('entryId').value);
    updateKindFields(Boolean((kind === 'file' && editing?.kind === 'file' && editing.file) || (kind === 'folder' && editing?.kind === 'folder' && editing.files?.length)));
  });
  if (!('webkitdirectory' in document.createElement('input'))) {
    byId('entryKind').querySelector('option[value="folder"]').disabled = true;
    byId('folderPickerFallback').hidden = false;
  }
  byId('entryFolderFiles').addEventListener('change', event => {
    const file = event.target.files?.[0];
    const firstPath = file?.webkitRelativePath || '';
    const folderName = firstPath.includes('/') ? firstPath.split('/')[0] : '';
    if (folderName && !byId('entryTitle').value.trim()) byId('entryTitle').value = folderName;
  });
  byId('textImportFile').addEventListener('change', importTextFile);
  byId('entryForm').addEventListener('submit', saveEntry);
  byId('folderForm').addEventListener('submit', createFolder);
  byId('editEntry').addEventListener('click', () => { const entry = findEntry(activeEntryId); if (entry) { closeModals(); openEntryModal(entry); } });
  byId('deleteEntry').addEventListener('click', deleteEntry);
  byId('downloadEntry').addEventListener('click', downloadEntry);
  byId('exportData').addEventListener('click', exportBackup);
  byId('importData').addEventListener('click', openImportPicker);
  byId('backupFile').addEventListener('change', event => importBackup(event.target.files?.[0]));
  byId('mergeBackup').addEventListener('click', () => { if (pendingBackup) applyBackup(pendingBackup, false); });
  byId('replaceBackup').addEventListener('click', () => { if (pendingBackup) applyBackup(pendingBackup, true); });
  byId('authButton').addEventListener('click', () => currentUser ? signOut() : openAuthModal());
  byId('authForm').addEventListener('submit', event => { event.preventDefault(); signIn(); });
  byId('createAccount').addEventListener('click', createAccount);
  $$('[data-close-modal]').forEach(button => button.addEventListener('click', closeModals));
  $$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }));

  render(); updateAuthView(); initializeAuth();
})();
