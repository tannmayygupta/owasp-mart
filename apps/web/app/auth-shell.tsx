import type { ReactNode } from 'react';

// The signed-out pages (sign in, create an account) share the console's split: a short pitch on the left, the form on a card on the right.
export function AuthShell({ children, eyebrow = 'OWASP Top 10, hands on', title = 'Break a real web shop, safely.' }: { children: ReactNode; eyebrow?: string; title?: string }) {
  return (
    <section className="auth">
      <div className="auth-intro">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="lead">Practise on a private copy of an online shop with planted weaknesses, or take the assessment a company invited you to. One account covers both.</p>
        <ol className="how">
          <li><span className="n">1</span><span><b>Create an account</b> and confirm your email.</span></li>
          <li><span className="n">2</span><span><b>Start your lab.</b> A private shop is built for you in seconds. Challenge logins are shown under &quot;How to begin&quot;.</span></li>
          <li><span className="n">3</span><span><b>Find the flag</b> of each challenge, before its countdown ends. Recruiters: sign up as a company and invite candidates.</span></li>
        </ol>
      </div>
      <div className="auth-card">{children}</div>
    </section>
  );
}
