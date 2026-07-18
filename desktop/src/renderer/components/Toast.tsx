export function Toast({ message, error }: { message: string; error?: boolean }) {
  return <div className={`toast ${error ? 'error' : ''}`}>{message}</div>;
}
