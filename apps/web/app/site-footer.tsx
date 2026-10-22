// The same small footer as the landing page (apps/lab-console/index.html), so every page of the product ends the same way.
export function SiteFooter() {
  return (
    <footer className="foot">
      <div className="foot-inner">
        <div className="foot-brand">
          <span className="brand-name">VulnMart <b>Lab</b></span>
          <p className="muted">A training sandbox. Everything you attack here is a private copy built to be broken.</p>
        </div>
        <nav className="foot-links" aria-label="Footer">
          <a href="/">Home</a>
          <a href="/signup?as=recruiter">For recruiters</a>
        </nav>
        <p className="foot-contact">Built by Tanmay<br /><a href="mailto:tanmayg460@gmail.com">tanmayg460@gmail.com</a></p>
      </div>
      <p className="foot-legal muted">&copy; 2026 VulnMart. Only attack the lab, never anything else.</p>
    </footer>
  );
}
