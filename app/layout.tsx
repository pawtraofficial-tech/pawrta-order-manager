import "./globals.css";
export const metadata = { title: "Pawtra Order Manager", robots: { index: false, follow: false } };
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body><header className="header"><div className="container"><strong>PAWTRA ORDER MANAGER</strong></div></header>{children}</body></html>}
