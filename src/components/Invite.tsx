import { Feedback } from "./Feedback.tsx";

export function Invite({ status, contactEmail }: { status?: string; contactEmail: string | null }) {
  return (
    <main className="invite-page">
      <h1><img src="/preview/logo.png" width={40} height={40} alt="" /> PDF/MIRA graph viewer</h1>
      <p className="invite-lede">Read a research paper beside a generated map of its argument. Follow the claims and evidence back to the authors’ words.</p>
      <section className="invite-access" aria-label="Private access">
        <p role="status">{status ?? "This is a private proof of concept. If you were invited, open the link in the message you received to enter."}</p>
        {contactEmail && <p><a href={`mailto:${contactEmail}`}>Request access</a></p>}
      </section>
      <figure>
        <img src="/preview/reader.png" width={1280} height={800} alt="PDF/MIRA reader with a highlighted passage on the left connected to its claim card on the right." />
        <figcaption>A highlighted passage in the paper connects to its claim in the map.</figcaption>
      </figure>
      <Feedback email={contactEmail} />
    </main>
  );
}
