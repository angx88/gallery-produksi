export default function Select({
  label,
  value,
  onChange,
  children,
  required = false,
  className = "",
  ...props
}) {
  return (
    <label className={`block ${className}`}>
      {label && (
        <span className="mb-1 block text-sm font-bold text-slate-700">
          {label}
        </span>
      )}
      <select
        value={value}
        onChange={onChange}
        required={required}
        className="w-full rounded-xl border px-3 py-2 text-sm font-semibold outline-none focus:ring-2 focus:ring-pink-300"
        {...props}
      >
        {children}
      </select>
    </label>
  );
}
