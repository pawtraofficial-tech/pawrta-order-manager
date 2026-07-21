import "./globals.css";
import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "Track Your Custom Artwork | Pawtra",
  description: "Follow your Pawtra order, review your custom artwork and share feedback with your artist.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <header className="header">
          <div className="container">
            <a className="brand" href="https://pawtra.net" aria-label="Pawtra home">PAWTRA<span>®</span></a>
            <nav aria-label="Customer navigation">
              <a href="https://pawtra.net">Shop</a>
              <a className="header-current" href="/track">Track my order</a>
            </nav>
          </div>
        </header>
        {children}
        <footer className="site-footer">
          <div className="container">
            <a className="brand" href="https://pawtra.net">PAWTRA<span>®</span></a>
            <p>Art made for the pets who make life better.</p>
            <p>© {new Date().getFullYear()} Pawtra</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
