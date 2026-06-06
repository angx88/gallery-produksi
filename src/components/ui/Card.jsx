export default function Card({ children, className = "" }) {
  return (
    <div className={`rounded-2xl border bg-white/95 p-4 shadow-sm ${className}`}>
      {children}
    </div>
  );
}
