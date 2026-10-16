import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { Upload, Trash2, Star, Image as ImageIcon } from "lucide-react";

export default function AdminPlotMediaModal({ plot, onClose }) {
  const plotId = plot?.id || plot?._id;
  const [mediaList, setMediaList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const fetchMedia = () => {
    if (!plot) return;
    setLoading(true);
    api.get(`/admin/plots/${plotId}/media`)
      .then((res) => setMediaList(res.data || []))
      .catch((err) => setError(err.response?.data?.error || "Failed to load media"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchMedia();
  }, [plot]);

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    setUploading(true);

    const fd = new FormData();
    fd.append("file", file);

    try {
      await api.post(`/admin/plots/${plotId}/media`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      fetchMedia();
    } catch (err) {
      setError(err.response?.data?.error || "Failed to upload image");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleSetPrimary = (mediaId) => {
    api.patch(`/admin/media/${mediaId}`, { is_primary: true })
      .then(() => fetchMedia())
      .catch((err) => alert(err.response?.data?.error || "Failed to set primary cover"));
  };

  const handleDelete = (mediaId) => {
    if (!window.confirm("Delete this property image? This action cannot be undone.")) return;

    api.delete(`/admin/media/${mediaId}`)
      .then(() => fetchMedia())
      .catch((err) => alert(err.response?.data?.error || "Failed to delete image"));
  };

  if (!plot) return null;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(15, 23, 42, 0.75)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}>
      <div style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: "12px", width: "100%", maxWidth: "650px", color: "#f8fafc", padding: "1.5rem", boxShadow: "0 20px 25px -5px rgba(0,0,0,0.5)" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.25rem", borderBottom: "1px solid #334155", pb: "0.75rem" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "1.2rem", fontWeight: "700" }}>
              Property Gallery — Plot #{plot.number}
            </h3>
            <div style={{ fontSize: "0.8rem", color: "#94a3b8", marginTop: "0.2rem" }}>
              Upload JPEG, PNG, or WEBP property images (Max 10 MB per image)
            </div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#94a3b8", fontSize: "1.5rem", cursor: "pointer" }}>
            &times;
          </button>
        </div>

        {error && (
          <div style={{ background: "#7f1d1d", color: "#fca5a5", border: "1px solid #991b1b", padding: "0.6rem 0.8rem", borderRadius: "6px", fontSize: "0.85rem", marginBottom: "1rem" }}>
            {error}
          </div>
        )}

        {/* Upload Action */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#0f172a", padding: "0.75rem 1rem", borderRadius: "8px", border: "1px solid #334155", marginBottom: "1.25rem" }}>
          <div style={{ fontSize: "0.85rem", color: "#cbd5e1" }}>
            Images Attached: <strong>{mediaList.length}</strong>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={handleFileUpload}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", background: "#3b82f6", color: "#fff", border: "none", padding: "0.5rem 1rem", borderRadius: "6px", fontWeight: "600", fontSize: "0.85rem", cursor: "pointer" }}
          >
            <Upload size={14} />
            {uploading ? "Uploading..." : "Upload Image"}
          </button>
        </div>

        {/* Media Grid */}
        <div style={{ maxHeight: "340px", overflowY: "auto", paddingRight: "0.25rem" }}>
          {loading ? (
            <div style={{ textAlign: "center", color: "#94a3b8", padding: "2rem" }}>Loading property gallery...</div>
          ) : mediaList.length === 0 ? (
            <div style={{ textAlign: "center", color: "#64748b", padding: "2.5rem", background: "#0f172a", borderRadius: "8px", border: "1px dashed #334155" }}>
              <ImageIcon size={32} style={{ marginBottom: "0.5rem", opacity: 0.5 }} />
              <div>No images uploaded for this plot yet.</div>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: "0.75rem" }}>
              {mediaList.map((m) => (
                <div key={m.id} style={{ background: "#0f172a", border: m.is_primary ? "2px solid #3b82f6" : "1px solid #334155", borderRadius: "8px", overflow: "hidden", display: "flex", flexDirection: "column" }}>
                  <div style={{ height: "110px", background: "#020617", position: "relative" }}>
                    <img src={m.url} alt={m.title} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    {m.is_primary && (
                      <span style={{ position: "absolute", top: "6px", left: "6px", background: "#2563eb", color: "#fff", fontSize: "0.65rem", fontWeight: "700", padding: "0.15rem 0.4rem", borderRadius: "4px", display: "flex", alignItems: "center", gap: "0.25rem" }}>
                        <Star size={10} fill="#fff" /> COVER
                      </span>
                    )}
                  </div>
                  <div style={{ padding: "0.5rem", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#0f172a" }}>
                    {!m.is_primary ? (
                      <button
                        onClick={() => handleSetPrimary(m.id)}
                        style={{ background: "transparent", border: "none", color: "#94a3b8", fontSize: "0.75rem", cursor: "pointer", padding: 0 }}
                      >
                        Set Cover
                      </button>
                    ) : (
                      <span style={{ fontSize: "0.75rem", color: "#60a5fa", fontWeight: "600" }}>Primary Cover</span>
                    )}
                    <button
                      onClick={() => handleDelete(m.id)}
                      style={{ background: "transparent", border: "none", color: "#fca5a5", cursor: "pointer", padding: "0.2rem" }}
                      title="Delete Image"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
