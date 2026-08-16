export const metadata = {
  title: 'Puffyn Insights',
  description: 'Puffyn Insights — internal build in progress',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
