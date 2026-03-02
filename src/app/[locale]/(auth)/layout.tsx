export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-canvas)] p-4">
      <div className="bg-card w-full max-w-[432px] rounded-md p-8 shadow-[0_10px_10px_rgba(0,0,0,0.04),0_20px_25px_rgba(0,0,0,0.01)]">
        {children}
      </div>
    </div>
  );
}
