import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { X } from "lucide-react";

function isBackdrop(event: MouseEvent<HTMLDialogElement>) {
  if (event.target !== event.currentTarget) return false;
  const { left, right, top, bottom } =
    event.currentTarget.getBoundingClientRect();
  return (
    event.clientX < left ||
    event.clientX > right ||
    event.clientY < top ||
    event.clientY > bottom
  );
}
export function Dialog({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
  busy = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const pointerStartedOutside = useRef(false);
  useEffect(() => {
    const element = ref.current;
    element?.showModal();
    return () => {
      element?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`settings-dialog ${wide ? "wide-dialog" : ""}`}
      aria-labelledby="dialog-title"
      onPointerDown={(event) => {
        pointerStartedOutside.current = event.button === 0 && isBackdrop(event);
      }}
      onPointerCancel={() => {
        pointerStartedOutside.current = false;
      }}
      onClick={(event) => {
        const dismiss = pointerStartedOutside.current && isBackdrop(event);
        pointerStartedOutside.current = false;
        if (dismiss && !busy) onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <h2 id="dialog-title">{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
