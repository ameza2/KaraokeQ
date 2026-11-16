import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getName, setLastScreenRoom, setName as saveName } from "../../lib/storage.ts";
import { RoomView } from "./RoomView.tsx";

const SCREEN_NAME = "Screen";

/** /r/:code (a person) or /r/:code/screen (the room's screen device). */
export default function Room({ screenMode = false }: { screenMode?: boolean }) {
  const code = useParams().code!.toUpperCase();
  const [name, setName] = useState<string | null>(getName() || null);
  useEffect(() => {
    if (screenMode) setLastScreenRoom(code);
  }, [screenMode, code]);

  if (screenMode) return <RoomView code={code} name={SCREEN_NAME} screenMode onRename={() => {}} />;

  if (!name)
    return (
      <NameForm
        code={code}
        onDone={(n) => {
          saveName(n);
          setName(n);
        }}
      />
    );
  return <RoomView code={code} name={name} onRename={(n) => (saveName(n), setName(n))} />;
}

function NameForm({ code, onDone, initial = "" }: { code: string; onDone: (n: string) => void; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <main className="home">
      <div className="orb" aria-hidden="true" />
      <h1>Room {code}</h1>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onDone(value.trim().slice(0, 24));
        }}
      >
        <label className="muted">What should we call you?</label>
        <input className="input" autoFocus maxLength={24} placeholder="Your name" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn primary big" disabled={!value.trim()}>
          Join the party
        </button>
      </form>
    </main>
  );
}
