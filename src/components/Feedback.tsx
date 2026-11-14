export function Feedback({ email }: { email: string | null }) {
  return email ? <footer className="small"><a href={`mailto:${email}`}>Feedback</a></footer> : null;
}
