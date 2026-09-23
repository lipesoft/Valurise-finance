# Desenvolvimento e qualidade

## Ferramentas

- **Graphify** cria um mapa navegável das relações entre os módulos. A integração Codex do projeto está em `.codex/skills/graphify`; depois de instalá-la ou atualizar seu `PATH`, reinicie o Codex para carregá-la.
- **Playwright Test** executa E2E no Chromium. O **Playwright CLI** e sua skill local estão em `.agents/skills/playwright-cli`.
- **Playwright Test Agents** fornecem planejador, gerador e reparador de testes em `.codex/agents`, com prompts em `.codex/prompts`.

Para preparar outra máquina com Graphify, instale `uv`, depois execute:

```bash
uv tool install graphifyy
graphify install --project --platform codex
uv tool update-shell
```

No Windows, abra um novo terminal/Codex depois de atualizar o `PATH`.

## Comandos

```bash
# Verificação local completa
npm run lint
npm test
npm run test:e2e
npm run build

# Navegador e evidências
npm run test:e2e:headed
npm run test:e2e:ui
npm run test:e2e:debug
npm run test:e2e:report
npx playwright install chromium

# Playwright CLI
npx playwright cli --help
npx playwright cli install --skills=agents

# Agentes de teste (recria os arquivos padrão; revise o diff)
npx playwright init-agents --loop=codex --prompts

# Mapa Graphify: extração estrutural e atualização incremental, sem custo de API
graphify update .
graphify query "Quais são os principais módulos e o fluxo de autenticação e dados?"
```

Graphify grava a saída gerada em `graphify-out/`, que fica fora do Git. Após mudanças de código, atualize o mapa antes de investigar relações entre módulos. A extração SQL é opcional; se o parser `tree-sitter-sql` não estiver disponível, as migrations SQL não entram no mapa.

## Segurança dos testes E2E

O servidor Playwright substitui as variáveis públicas e secretas do Supabase por valores fictícios locais por padrão. Os E2E automatizados interceptam as rotas de login, cadastro e recuperação que exercitariam serviços externos. O endereço de e-mail `.invalid` usado nos testes não é entregável. A configuração local não lê o `.env.local` como fonte de credenciais para o servidor E2E.

O runner sempre inicia seu próprio servidor local e não reutiliza uma instância que possa estar ligada a dados reais. Se a porta 3000 estiver ocupada, pare o servidor de desenvolvimento antes de iniciar os E2E.

O teste `authenticated-login.spec.ts` é ignorado por padrão. Para executá-lo, configure no ambiente do processo (não em arquivos versionados) um projeto Supabase **dedicado, não produtivo**, com um usuário aprovado e ativo:

```text
E2E_SUPABASE_URL
E2E_SUPABASE_PUBLISHABLE_KEY
E2E_SUPABASE_SECRET_KEY
E2E_TEST_IDENTIFIER
E2E_TEST_PASSWORD
```

As cinco variáveis precisam estar definidas juntas. O teste de autenticação desativa vídeo, screenshot e trace para evitar guardar credenciais. Nunca configure esse teste com o projeto de produção, nem compartilhe os artefatos de execução.

## Artefatos

`test-results/`, `playwright-report/`, `.playwright-cli/`, `graphify-out/` e pastas temporárias do Playwright são ignoradas pelo Git. Os relatórios podem registrar dados da página: examine-os antes de compartilhá-los.
