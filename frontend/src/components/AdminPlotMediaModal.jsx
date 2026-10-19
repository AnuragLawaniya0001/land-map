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

  return (
    <div className="lm-modal-shade" data-testid="plot-media-modal-shade">
      <div className="lm-modal" style={{ width: "min(680px, 95vw)" }} data-testid="plot-media-modal">
        {/* Header */}
        <div className="lm-modal-head">
          <div>
            <p className="lm-eyebrow">PROPERTY GALLERY</p>
            <h3 className="text-lg font-bold text-white">Plot #{plot.number} Media</h3>
            <div className="text-xs text-slate-400 mt-0.5">
              Upload JPEG, PNG, or WEBP property images (Max 10 MB per image)
            </div>
          </div>
          <button className="lm-icon-btn" onClick={onClose} data-testid="close-media-modal">
            &times;
          </button>
        </div>

        {error && (
          <div className="lm-error mb-4" data-testid="media-modal-error">
            {error}
          </div>
        )}

        {/* Upload Action */}
        <div className="flex justify-between items-center p-3.5 rounded-xl bg-white/[0.02] border border-white/[0.08] mb-4">
          <div className="text-xs text-slate-300">
            Images Attached: <strong className="text-white">{mediaList.length}</strong>
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
            className="lm-btn-glow px-3.5 py-1.5 text-xs font-semibold gap-1.5"
          >
            <Upload size={14} />
            {uploading ? "Uploading…" : "Upload Image"}
          </button>
        </div>

        {/* Media Grid */}
        <div className="max-h-[340px] overflow-y-auto pr-1">
          {loading ? (
            <div className="text-center text-slate-400 text-xs py-8">Loading property gallery…</div>
          ) : mediaList.length === 0 ? (
            <div className="text-center text-slate-500 py-10 bg-white/[0.02] rounded-2xl border border-dashed border-white/10 flex flex-col items-center justify-center gap-2">
              <ImageIcon size={32} className="opacity-40" />
              <div className="text-xs">No images uploaded for this plot yet.</div>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {mediaList.map((m) => (
                <div
                  key={m.id}
                  className={`rounded-xl overflow-hidden flex flex-col bg-white/[0.02] border transition-all ${
                    m.is_primary ? "border-emerald-500/60 ring-1 ring-emerald-500/40" : "border-white/[0.08]"
                  }`}
                >
                  <div className="h-28 bg-black/40 relative overflow-hidden">
                    <img src={m.url} alt={m.title} className="w-full h-full object-cover" />
                    {m.is_primary && (
                      <span className="absolute top-2 left-2 bg-emerald-600/90 backdrop-blur-sm text-white text-[10px] font-bold px-2 py-0.5 rounded flex items-center gap-1 shadow-md">
                        <Star size={10} fill="#fff" /> COVER
                      </span>
                    )}
                  </div>
                  <div className="p-2.5 flex justify-between items-center bg-black/20 text-xs">
                    {!m.is_primary ? (
                      <button
                        onClick={() => handleSetPrimary(m.id)}
                        className="text-slate-400 hover:text-white text-xs cursor-pointer bg-transparent border-0 p-0"
                      >
                        Set Cover
                      </button>
                    ) : (
                      <span className="text-xs text-emerald-400 font-semibold">Primary Cover</span>
                    )}
                    <button
                      onClick={() => handleDelete(m.id)}
                      className="text-rose-400 hover:text-rose-300 cursor-pointer bg-transparent border-0 p-1 rounded"
                      title="Delete Image"
                    >
                      <Trash2 size={13} />
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
