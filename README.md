# VALURISE

Organizador financeiro pessoal mobile-first, em português do Brasil. O Dashboard é a home e o lançador guiado registra ações; opcionalmente, cada usuário pode conectar sua própria conta OpenAI, Gemini ou DeepSeek para conversar sobre seus dados.

## Stack

Next.js App Router, TypeScript, Tailwind, Supabase/Postgres (Auth, RLS e sincronização), Vitest e PWA básica.

## Começar

```bash
npm install
copy .env.example .env.local
npm run dev
```

Crie um projeto Supabase, configure `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` e o segredo de servidor `SUPABASE_SECRET_KEY`. A aplicação aplica RLS nas tabelas financeiras e usa o Auth para isolar contas. O estado atual sincroniza os dados financeiros autenticados em `user_financial_state`, com uma cópia local e controle otimista de versão; a migração gradual para tabelas normalizadas ainda é trabalho pendente. Não rode `supabase db push` em um banco existente sem primeiro reconciliar o histórico de migrations local com o ledger de produção.

## Verificação

`npm run lint`, `npm test` e `npm run build`.

## IA pessoal opcional

Em **Configurações → IA pessoal**, o usuário escolhe OpenAI, Gemini ou DeepSeek e informa a própria API key. A chave é criptografada com `VALURISE_AI_ENCRYPTION_KEY`, usada somente no servidor e nunca devolvida ao navegador. O envio de contexto financeiro exige consentimento separado e revogável; o chat não cria nem altera movimentações.

## Deploy

Cadastre as variáveis do Supabase e `VALURISE_AI_ENCRYPTION_KEY` no projeto Vercel e publique pelo fluxo conectado ao Git. Nunca use ou exponha `SUPABASE_SECRET_KEY` no navegador. Os textos de privacidade e termos são rascunhos operacionais e precisam de revisão jurídica antes de serem tratados como documentos finais de conformidade.
