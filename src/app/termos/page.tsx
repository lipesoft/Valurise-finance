import { LegalDocumentPage } from "@/components/legal-document";

export const metadata = { title: "Termos de Uso | Valurise", description: "Condições para usar os recursos da Valurise." };

export default function TermsPage() {
  return <LegalDocumentPage documentKey="terms" />;
}
