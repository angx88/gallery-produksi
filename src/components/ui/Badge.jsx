export default function Badge({ children, className = "" }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-black ${className}`}>
      {children}
    </span>
  );
}
