import Image from "next/image";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { legalDocuments, type LegalDocument } from "@/lib/legal-content";

export function LegalDocumentPage({ documentKey }: { documentKey: keyof typeof legalDocuments }) {
  const document: LegalDocument = legalDocuments[documentKey];
  return (
    <main className="min-h-dvh bg-[var(--bg)] px-4 py-6 text-[var(--fg)] sm:px-6 sm:py-10">
      <header className="mx-auto flex max-w-3xl items-center justify-between">
        <Link href="/" className="flex items-center gap-2 rounded-xl py-2 text-sm font-semibold" aria-label="Voltar à Valurise">
          <Image src="/valurise-icon.webp" alt="" width={36} height={36} className="h-8 w-8 object-contain" priority />
          <span>VALURISE</span>
        </Link>
        <Link href="/" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-[var(--panel2)] px-3 text-sm">
          <ArrowLeft size={16} aria-hidden="true" /> Voltar
        </Link>
      </header>
      <article className="panel mx-auto mt-6 max-w-3xl rounded-3xl p-5 sm:mt-8 sm:p-9">
        <p className="text-xs font-semibold uppercase tracking-[.16em] text-[var(--accent)]">Central de privacidade</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{document.title}</h1>
        <p className="muted mt-3 text-base leading-7">{document.summary}</p>
        <p className="muted mt-4 text-xs">Versão {document.version} · Revisada em 23 de setembro de 2026</p>
        <div className="mt-7 divide-y divide-[var(--border)]">
          {document.sections.map((section) => (
            <section key={section.heading} className="py-5 first:pt-0 last:pb-0">
              <h2 className="text-base font-semibold">{section.heading}</h2>
              {section.paragraphs?.map((paragraph) => <p key={paragraph} className="muted mt-2 text-sm leading-6">{paragraph}</p>)}
              {section.bullets && <ul className="muted mt-3 list-disc space-y-2 pl-5 text-sm leading-6">{section.bullets.map((item) => <li key={item}>{item}</li>)}</ul>}
            </section>
          ))}
        </div>
      </article>
      <nav aria-label="Documentos legais" className="mx-auto mt-5 flex max-w-3xl flex-wrap gap-x-5 gap-y-2 px-1 text-sm text-[var(--accent)]">
        <Link href="/privacidade">Privacidade</Link><Link href="/termos">Termos de uso</Link><Link href="/cookies">Cookies</Link>
      </nav>
    </main>
  );
}
