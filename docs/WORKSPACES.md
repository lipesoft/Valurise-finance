# Arquitetura multi-workspace

O workspace separa os dados financeiros da identidade de autenticação. Cada conta ativa possui um espaço pessoal; empresas são espaços novos, vazios e independentes. A estrutura permite memberships e papéis, mas nesta etapa somente o criador/owner pode criar uma empresa — convites e colaboração empresarial ainda não fazem parte do produto.

## Resolução e isolamento

- `user_active_workspaces` guarda a preferência padrão que abre o app. A interface envia o workspace em uso a cada chamada; APIs e RLS validam sessão, membership ativa, workspace não arquivado e papel. A preferência global não bloqueia outra sessão/dispositivo que continue usando seu workspace já aberto.
- RLS nas tabelas financeiras exige membership no workspace solicitado; gravações ainda respeitam o papel. Triggers impedem atribuir registros a outro criador e mudar sua associação de workspace.
- O documento financeiro atual continua em `user_financial_state`, agora identificado por `workspace_id`. O backfill preenche o workspace pessoal sem reescrever o JSON financeiro. A empresa começa com um documento vazio.
- A troca espera gravações pendentes, oculta a tela anterior e monta a nova árvore com chave/cache local próprios. Tema e dados locais ficam separados por workspace.
- Conexão, consentimento, propostas, mensagens e uso da Val são associados ao workspace. A consulta da Val usa somente o documento autorizado na chamada. O compartilhamento legado de metas permanece pessoal e separado dos documentos empresariais.

## Migração e verificação

Migration: `supabase/migrations/20260925191239_multi_workspace_foundation.sql`.

Ela é transacional, preserva as linhas e o conteúdo JSON atuais, cria memberships pessoais, associa as tabelas financeiras e de IA ao workspace pessoal, instala chaves estrangeiras compostas para referências entre dados e substitui as policies antigas. Backfills usam `ON CONFLICT` e atualizam somente associações nulas; a migration pode ser reaplicada sem duplicar workspaces.

Após aplicar em um ambiente de teste, confira pelo menos:

```sql
select type, count(*) from public.workspaces group by type;
select count(*) from public.user_financial_state where workspace_id is null;
select count(*) from public.accounts where workspace_id is null;
select count(*) from public.transactions where workspace_id is null;
select count(*) from public.workspace_memberships where status = 'active';
```

As contagens das tabelas financeiras antes/depois devem permanecer iguais; todo estado antigo deve apontar para exatamente um workspace pessoal. Ainda é necessário validar no Supabase real antes de produção. Esta tarefa não aplicou a migration ao banco nem publicou o código.

## Rollback e limites

Não reverta removendo `workspace_id` nem recriando policies antigas por `user_id`: isso apagaria ou exporia dados de empresas. Se a aplicação precisar voltar à versão anterior, primeiro prepare uma migration de compatibilidade que preserve os workspaces empresariais e reponha acesso somente ao workspace pessoal; mantenha backup e valide os dados antes da troca de código.

O modo empresarial reutiliza por enquanto o documento e telas financeiras atuais com dados separados; ainda não inclui contas a pagar/receber, DRE, papéis configuráveis, convite de membros ou transferência de titularidade. A validação de CNPJ verifica formato e dígitos, não consulta a Receita Federal. A exclusão definitiva de um owner remove workspaces sem outros membros ativos; se houver membros, a exclusão é bloqueada até que a titularidade seja transferida.
