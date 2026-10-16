import { useState } from "react";
import { X, MessageCircle } from "lucide-react";
import { api, errMsg } from "@/lib/api";
import { waLink } from "@/lib/geo";

export default function WhatsAppDialog({ colony, plot, zone, onClose }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const subject = plot ? `Inquiry about plot number ${plot.number}` : `Inquiry about ${colony.name}`;
  const message = [
    `Hi ${colony.name} team,`,
    plot
      ? `I'm interested in Plot ${plot.number}${zone ? ` (${zone.name})` : ""} – ${Math.round(plot.area_sqyd || plot.area_sqm * 1.19599)} sq yd / ${Math.round(plot.area_sqm)} m² / ${Math.round(plot.area_sqft || plot.area_sqm * 10.7639)} ft² (${plot.dimensions}). Please share price and availability.`
      : `I'd like to know more about plots in ${colony.name}. Please share details.`,
    name.trim() ? `Name: ${name.trim()}` : null,
    `My mobile: ${phone.trim() || "__________"}`,
  ].filter(Boolean).join("\n");

  const send = async () => {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) { setErr("Enter a valid mobile number (10 digits)"); return; }
    
    setSubmitting(true);
    setErr("");

    try {
      // 1. Persist inquiry to MongoDB backend first
      await api.post("/public/inquiries", {
        colony_id: colony.id || colony._id,
        plot_id: plot ? (plot.id || plot._id) : (colony.plots?.[0]?.id || "general"),
        name: name.trim() || "Interested Buyer",
        phone: phone.trim(),
        message,
        fax_number: "", // Honeypot field
      });

      // 2. Upon DB success, open WhatsApp
      try {
        window.open(waLink(colony.whatsapp_number, message), "_blank", "noopener");
      } catch (waErr) {
        console.warn("WhatsApp open error", waErr);
      }
      onClose();
    } catch (e) {
      setErr(errMsg(e) || "Unable to save inquiry. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="lm-modal-shade" onClick={onClose}>
      <div className="lm-modal lm-wa-modal" onClick={(e) => e.stopPropagation()} data-testid="whatsapp-dialog">
        <div className="lm-modal-head">
          <h3><MessageCircle size={18} /> {subject}</h3>
          <button className="lm-icon-btn" onClick={onClose} data-testid="whatsapp-close"><X size={16} /></button>
        </div>
        <p className="lm-muted">Your inquiry will be registered and WhatsApp will open with this message.</p>
        <label>Your name (optional)</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" data-testid="whatsapp-name" disabled={submitting} />
        <label>Your mobile number</label>
        <input value={phone} onChange={(e) => { setPhone(e.target.value); setErr(""); }} placeholder="+91 98XXX XXXXX" inputMode="tel" data-testid="whatsapp-phone" disabled={submitting} />
        {err && <div className="lm-error" data-testid="whatsapp-error">{err}</div>}
        <pre className="lm-wa-preview" data-testid="whatsapp-preview">{message}</pre>
        <button className="lm-wa-cta" onClick={send} disabled={submitting} data-testid="whatsapp-send">
          <MessageCircle size={16} /> {submitting ? "Saving inquiry…" : "Open WhatsApp & send"}
        </button>
      </div>
    </div>
  );
}
