# Valurise

Organizador financeiro pessoal mobile-first, em português do Brasil. O Dashboard é a home e o lançador guiado registra ações; opcionalmente, cada usuário pode conectar sua própria conta OpenAI ou Gemini para conversar sobre seus dados.

## Stack

Next.js App Router, TypeScript, Tailwind, Supabase/Postgres (schema e RLS), Vitest e PWA básica.

## Começar

```bash
npm install
copy .env.example .env.local
npm run dev
```

Crie um projeto Supabase, preencha `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, e execute todas as migrations em `supabase/migrations` pelo Supabase CLI ou SQL Editor. O schema usa centavos (`bigint`) para não introduzir imprecisão monetária e todas as tabelas possuem `user_id` e RLS por proprietário. Após configurar Supabase Auth, o login por e-mail sincroniza automaticamente o documento financeiro entre dispositivos; o login provisório por usuário permanece apenas como compatibilidade local.

## Verificação

`npm run lint`, `npm test` e `npm run build`.

## IA pessoal opcional

Em **Configurações → IA pessoal**, o usuário escolhe OpenAI ou Gemini e informa a própria API key. A chave é criptografada com `VALURISE_AI_ENCRYPTION_KEY`, usada somente no servidor e nunca devolvida ao navegador. O chat envia um retrato financeiro limitado do próprio usuário; ele não cria nem altera movimentações.

## Deploy

Cadastre as variáveis do Supabase e `VALURISE_AI_ENCRYPTION_KEY` no projeto Vercel e execute `npx vercel --prod`. Nunca use ou exponha a chave `service_role` no navegador.
