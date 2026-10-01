# E-mail de redefinição de senha

Assunto sugerido: **Redefina sua senha da Valurise**

O arquivo `recovery.html` é o conteúdo do template **Reset Password / Redefinição de senha** do Supabase Auth. Ele identifica a Valurise no remetente visual, no título e no rodapé, e mantém `{{ .ConfirmationURL }}` para que o Supabase valide o link.

Para aplicar no projeto hospedado, abra **Authentication → Email Templates → Reset Password**, atualize o assunto e substitua o corpo pelo conteúdo de `recovery.html`. Em **Authentication → SMTP Settings**, configure um servidor SMTP autorizado e defina o nome do remetente como **Valurise**, usando um endereço em domínio verificado. Sem SMTP personalizado, o Supabase controla o remetente e pode impedir a personalização do template em projetos Free recentes.

O endereço de retorno usado pelo Valurise é `/?reset-password=1`; confirme que o domínio de produção está autorizado nas URLs de redirecionamento do Supabase. Não inclua chaves ou credenciais neste repositório.
