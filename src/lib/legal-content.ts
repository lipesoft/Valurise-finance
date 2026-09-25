export const legalVersions = {
  privacy: "2026-09-23-v1",
  terms: "2026-09-23-v1",
  cookies: "2026-09-23-v1",
  aiSharing: "2026-09-25-v3",
} as const;

export type LegalDocument = {
  title: string;
  summary: string;
  version: string;
  sections: { heading: string; paragraphs: string[]; bullets?: string[] }[];
};

export const legalDocuments: Record<"privacy" | "terms" | "cookies", LegalDocument> = {
  privacy: {
    title: "Política de Privacidade",
    summary: "Como a Valurise utiliza e protege seus dados pessoais e financeiros.",
    version: legalVersions.privacy,
    sections: [
      { heading: "Quem é responsável", paragraphs: ["A Valurise é operada por sua equipe responsável no Brasil. Para dúvidas, solicitações ou exercício de direitos sobre dados pessoais, escreva para f.rodrigues0907@gmail.com."] },
      { heading: "Dados tratados", paragraphs: ["Tratamos os dados necessários para criar e proteger sua conta e para oferecer os recursos que você escolhe usar. Isso pode incluir nome, e-mail, nome de usuário, foto de perfil, informações de acesso, preferências, consentimentos e os dados financeiros que você registra (como contas, cartões, lançamentos, orçamentos, metas e investimentos).", "A Valurise também mantém dados técnicos mínimos de segurança e operação, como registros de acesso e erros da aplicação."] },
      { heading: "Finalidades e bases", paragraphs: ["Usamos esses dados para autenticar você, sincronizar suas informações entre dispositivos, exibir análises financeiras solicitadas, proteger a plataforma, atender solicitações e cumprir obrigações legais. O tratamento necessário ao serviço se apoia na execução da relação com você e em interesses legítimos de segurança e funcionamento; recursos opcionais, como compartilhamento de dados financeiros com uma IA pessoal, dependem de sua escolha explícita."] },
      { heading: "Armazenamento e prestadores", paragraphs: ["A aplicação é hospedada na Vercel e os serviços de autenticação e banco de dados usam Supabase. Esses prestadores processam dados para fornecer infraestrutura, segurança e disponibilidade, conforme seus contratos e políticas.", "Se você conectar OpenAI, Gemini, DeepSeek, Groq ou OpenRouter e habilitar o contexto financeiro, a Valurise envia sua pergunta e somente os resultados das ferramentas necessários à resposta ao provedor que você escolheu — nunca a todos eles. A Val consulta esses dados com sua sessão autenticada e acesso protegido por RLS; não envia o banco inteiro. Se você também habilitar ações financeiras, a Val poderá preparar somente propostas de receitas ou despesas comuns. A proposta mostra os dados antes de qualquer gravação e só é registrada após sua confirmação explícita; propostas não confirmadas expiram. Transferências, cartões/parcelas, investimentos, metas, edição e exclusão não são permitidos por esse recurso. O provedor escolhido processa mensagens e dados recebidos conforme os próprios termos e políticas. Você pode revogar o consentimento ou remover a conexão nas Configurações. A Valurise mantém métricas técnicas agregadas de uso (provedor, modelo, tempo, erros e tokens retornados), mas não grava prompts ou respostas nesses registros de uso."] },
      { heading: "Compartilhamento de metas", paragraphs: ["Uma meta só é compartilhada depois que você envia um convite e a outra pessoa o aceita. O acesso compartilhado se limita à meta e às contribuições relacionadas; suas demais informações financeiras permanecem privadas."] },
      { heading: "Retenção e exclusão", paragraphs: ["Mantemos os dados enquanto sua conta estiver ativa e pelo tempo necessário para operar o serviço, cumprir obrigações e resolver disputas. Você pode exportar seus dados ou solicitar a exclusão da conta nas Configurações. Cópias de segurança operacionais podem permanecer por um período limitado conforme os ciclos de retenção dos provedores e são protegidas contra uso rotineiro."] },
      { heading: "Seus direitos", bullets: ["Confirmar se tratamos seus dados e solicitar acesso ou correção.", "Solicitar anonimização, bloqueio ou exclusão quando aplicável.", "Solicitar portabilidade e informações sobre compartilhamentos.", "Revogar consentimentos opcionais e pedir revisão de decisões automatizadas, quando aplicável."], paragraphs: ["Para exercer seus direitos previstos na LGPD, entre em contato pelo e-mail informado acima. Poderemos confirmar sua identidade antes de atender a solicitação."] },
      { heading: "Segurança", paragraphs: ["Aplicamos autenticação, políticas de acesso por usuário no banco e controles técnicos para reduzir riscos. Nenhum serviço conectado à internet pode prometer segurança absoluta; avise-nos imediatamente se suspeitar de acesso indevido à sua conta."] },
      { heading: "Atualizações", paragraphs: ["Podemos atualizar esta política quando o produto ou a legislação mudar. A versão e a data no topo indicam a revisão vigente; alterações que exijam nova escolha serão apresentadas novamente."] },
    ],
  },
  terms: {
    title: "Termos de Uso",
    summary: "Regras simples para usar a Valurise com clareza e segurança.",
    version: legalVersions.terms,
    sections: [
      { heading: "Sobre o serviço", paragraphs: ["A Valurise é uma ferramenta de organização e acompanhamento financeiro pessoal. Os dados exibidos dependem das informações que você registra e das integrações que decide habilitar."] },
      { heading: "Sua conta", bullets: ["Mantenha suas credenciais em sigilo e use informações corretas.", "Você é responsável pelos lançamentos, valores, classificações e decisões tomadas com base neles.", "Não tente acessar contas, dados ou funcionalidades sem autorização."], paragraphs: ["O acesso a novos cadastros pode depender de aprovação. Podemos suspender contas em caso de uso abusivo, risco de segurança ou violação destes termos."] },
      { heading: "Informação financeira", paragraphs: ["A Valurise oferece organização, cálculos e projeções determinísticas; não é banco, corretora, consultoria de investimentos, contabilidade ou aconselhamento jurídico. As informações não constituem recomendação de investimento nem garantia de resultado. Confira os dados e consulte um profissional qualificado antes de decisões relevantes."] },
      { heading: "Recursos de IA", paragraphs: ["A IA é opcional e só deve receber contexto financeiro quando você conectar um provedor e habilitar essa opção. Respostas podem estar incompletas ou incorretas: confira os dados e não use a IA como única base para decisões financeiras. Se você habilitar ações, a Val pode preparar propostas limitadas de receitas e despesas comuns; cada lançamento só é gravado após sua confirmação explícita. A IA não move dinheiro, executa pagamentos, transferências, compras em cartão, investimentos, metas, edições ou exclusões."] },
      { heading: "Disponibilidade e propriedade", paragraphs: ["Trabalhamos para manter o serviço disponível e proteger seus dados, mas podem ocorrer interrupções para manutenção, incidentes ou falhas de terceiros. Você mantém a responsabilidade por seus registros e pode exportar um backup pelas Configurações. A marca, o software e a identidade visual da Valurise pertencem aos respectivos titulares."] },
      { heading: "Encerramento e contato", paragraphs: ["Você pode deixar de usar a Valurise e solicitar a exclusão da conta nas Configurações. Para dúvidas sobre estes termos, privacidade ou suporte, escreva para f.rodrigues0907@gmail.com."] },
      { heading: "Atualizações", paragraphs: ["Estes termos podem ser revisados para refletir mudanças do serviço ou da legislação. A versão e a data indicadas no topo identificam o texto vigente."] },
    ],
  },
  cookies: {
    title: "Cookies e armazenamento local",
    summary: "O que fica salvo no navegador e como controlar suas preferências.",
    version: legalVersions.cookies,
    sections: [
      { heading: "O que usamos", paragraphs: ["A Valurise utiliza tecnologias locais do navegador para manter a sessão segura e lembrar preferências da interface, como tema e escolha de cookies. O Supabase Auth pode armazenar tokens de sessão no armazenamento do navegador para manter seu login entre acessos."] },
      { heading: "Dados financeiros neste dispositivo", paragraphs: ["Na implementação atual, parte do estado financeiro também é mantida em armazenamento local para continuidade e sincronização da aplicação. Isso significa que apagar os dados do navegador pode remover uma cópia local; use Exportar backup nas Configurações antes de limpar o armazenamento. Com uma conta autenticada, os dados também são sincronizados no Supabase."] },
      { heading: "Cookies opcionais", paragraphs: ["A Valurise não usa atualmente cookies de publicidade nem ferramentas de rastreamento analítico de terceiros. A opção 'Aceitar preferências' autoriza somente o armazenamento de preferências de experiência descrito nesta página; os recursos essenciais de autenticação permanecem ativos em qualquer escolha."] },
      { heading: "Gerenciar sua escolha", paragraphs: ["Você pode escolher 'Apenas necessários' ou 'Aceitar preferências' na faixa de cookies e alterar essa opção a qualquer momento em Configurações → Privacidade → Gerenciar cookies. A escolha é salva neste navegador e, quando você está conectado, sincronizada à sua conta."] },
      { heading: "Limpeza do navegador", paragraphs: ["Você pode limpar dados do site nas configurações do navegador. Isso pode encerrar sua sessão e remover preferências ou dados locais não sincronizados. Para dúvidas, fale com f.rodrigues0907@gmail.com."] },
    ],
  },
};
