import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { formatBRL, type FinanceTransaction } from "@/lib/finance";

type FinancePrintDocumentProps = {
  title: string;
  subtitle: string;
  transactions: FinanceTransaction[];
  metrics?: { label: string; value: string }[];
  accounts?: { name: string; balanceCents: number }[];
  categories?: { name: string; amountCents: number }[];
};

function transactionLabel(transaction: FinanceTransaction) {
  if (transaction.type === "transfer") return "Transferência";
  if (transaction.type === "investment") return "Aporte";
  if (transaction.type === "income") return transaction.subtype === "salary" ? "Salário" : "Receita";
  return transaction.subtype === "pix_credit" ? "Pix no crédito" : "Despesa";
}

export function FinancePrintDocument({
  title,
  subtitle,
  transactions,
  metrics = [],
  accounts = [],
  categories = [],
}: FinancePrintDocumentProps) {
  return (
    <article className="finance-print-root" aria-label={`${title} para exportação PDF`}>
      <header className="finance-print-header">
        <div className="finance-print-brand">VALURISE</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
        <small>Gerado em {format(new Date(), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}</small>
      </header>

      {metrics.length > 0 && (
        <section className="finance-print-metrics" aria-label="Resumo financeiro">
          {metrics.map((metric) => (
            <div key={metric.label}>
              <span>{metric.label}</span>
              <b>{metric.value}</b>
            </div>
          ))}
        </section>
      )}

      {accounts.length > 0 && (
        <section className="finance-print-section">
          <h2>Saldos das contas</h2>
          <table>
            <thead><tr><th>Conta</th><th>Saldo atual</th></tr></thead>
            <tbody>{accounts.map((account) => <tr key={account.name}><td>{account.name}</td><td>{formatBRL(account.balanceCents)}</td></tr>)}</tbody>
          </table>
        </section>
      )}

      {categories.length > 0 && (
        <section className="finance-print-section">
          <h2>Despesas por categoria</h2>
          <table>
            <thead><tr><th>Categoria</th><th>Total</th></tr></thead>
            <tbody>{categories.map((category) => <tr key={category.name}><td>{category.name}</td><td>{formatBRL(category.amountCents)}</td></tr>)}</tbody>
          </table>
        </section>
      )}

      <section className="finance-print-section">
        <h2>Movimentações ({transactions.length})</h2>
        {transactions.length ? (
          <table>
            <thead><tr><th>Data</th><th>Descrição</th><th>Tipo</th><th>Conta / destino</th><th>Valor</th></tr></thead>
            <tbody>{transactions.map((transaction) => (
              <tr key={transaction.id}>
                <td>{format(new Date(transaction.date), "dd/MM/yyyy", { locale: ptBR })}</td>
                <td>{transaction.description || transaction.category}</td>
                <td>{transactionLabel(transaction)}</td>
                <td>{transaction.type === "transfer" ? `${transaction.account} → ${transaction.destinationAccount || "—"}` : transaction.account}</td>
                <td>{transaction.type === "income" ? "+" : transaction.type === "transfer" ? "" : "−"}{formatBRL(transaction.amountCents)}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : <p>Nenhuma movimentação no período selecionado.</p>}
      </section>
      <footer className="finance-print-footer">Documento financeiro gerado localmente pelo Valurise.</footer>
    </article>
  );
}
