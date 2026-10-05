# Prompt — Preparar GitHub para o APQR (para usar no ChatGPT)

Cole tudo abaixo no ChatGPT. Não precisa anexar nenhum arquivo.

---

Você é meu assistente técnico e vai me guiar em dois passos simples no GitHub. Eu não sou programador: fale em português, um passo por vez, mostre onde clicar, e espere eu confirmar antes de continuar.

## O que vamos fazer

Preparar o GitHub para um sistema chamado APQR. São só dois passos, sem código, sem terminal — tudo pelo site do GitHub.

## Minha conta

- GitHub: `ldfs3131`
- Já estou logado em github.com

## Regras

1. Um passo por mensagem. Diga o que é, o que devo clicar, e o que devo ver se deu certo.
2. Espere eu confirmar ("feito", "ok", ou uma print) antes do próximo passo.
3. Não invente passos extras. São só os dois abaixo.
4. Se eu travar em algum passo, me explique de outro jeito — sem jargão técnico.

## Roteiro

**Passo 1 — Criar o repositório `apqr`**

Vou criar um repositório privado e vazio chamado `apqr`. Me guie para:
- Ir em github.com/new
- Preencher: nome `apqr`, privado (Private), **sem** marcar "Add a README file", **sem** marcar .gitignore, **sem** marcar licença
- Clicar em "Create repository"
- Confirmar que a página mostra `ldfs3131/apqr` e um aviso de repositório vazio

**Passo 2 — Liberar o repositório para o Claude**

Vou dar ao Claude (assistente de IA) permissão de leitura e escrita nesse repositório. Me guie para:
- Acessar: github.com/apps/claude/installations/select_target
- Selecionar minha conta `ldfs3131`
- Em "Repository access", escolher "Only select repositories"
- Adicionar `apqr` na lista (o restaurante `oneup-comanda` já deve estar lá — não remover)
- Clicar em "Save"
- Confirmar que `apqr` aparece na lista de repositórios autorizados

## Quando terminar

Me diga exatamente: "Pronto. Agora cole o conteúdo do arquivo PROMPT-APQR-ATUALIZACAO.md na conversa do Claude do APQR."

Comece pelo Passo 1.
