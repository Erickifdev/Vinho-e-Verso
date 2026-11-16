Vinho & Verso

Um espaço pessoal para guardar e organizar poemas, textos, ideias, projetos e arquivos — tudo em uma interface com tons escuros, vinho e vermelho.

 O que você pode fazer

- Escrever poemas com versos e estrofes preservados.
- Importar poemas e textos em arquivos `.txt` ou `.md`.
- Guardar arquivos na sua biblioteca.
- Criar coleções para organizar seus conteúdos.
- Pesquisar, favoritar, editar e apagar itens.
- Apagar coleções criadas por você; os itens delas são movidos para **Anotações**.
- Exportar e importar uma cópia da biblioteca.
- Entrar em uma conta para sincronizar os dados com o Supabase.

 Tecnologias

- HTML, CSS e JavaScript
- Supabase para autenticação, banco de dados e armazenamento de arquivos

 Como usar

1. Abra o site.
2. Clique em **Guardar algo**.
3. Escolha o tipo: poema, texto, ideia, projeto ou arquivo.
4. Para importar um poema ou texto, selecione um arquivo `.txt` ou `.md`.
5. Escolha uma coleção e clique em **Guardar item**.

## Dados e privacidade

Os dados da biblioteca são salvos no navegador e, quando você entra na sua conta, sincronizados com o Supabase. Arquivos anexados ficam no armazenamento privado da conta.

Use **Baixar cópia** para salvar um backup da biblioteca. Para recuperar os dados, escolha **Importar cópia**.

## Configuração

O projeto usa um arquivo `supabase-config.js` para conectar ao Supabase. Configure nele a URL do projeto e a chave **publishable**. Nunca coloque uma chave `secret` ou `service_role` no código publicado.

Também é necessário configurar no Supabase o banco de dados, as políticas de acesso e o bucket privado de arquivos usados pelo projeto.

## Publicação

O site pode ser publicado pelo GitHub Pages ou por outro serviço de hospedagem de sites estáticos. Depois de enviar as alterações ao repositório, aguarde a atualização da publicação.

---

Feito para guardar o que importa. ♥ 
