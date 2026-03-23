import { useState, useEffect } from 'react';
import { encodeCurve } from './SavedCurves';

function ShareIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3"/>
      <circle cx="6" cy="12" r="3"/>
      <circle cx="18" cy="19" r="3"/>
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
    </svg>
  );
}

// entry: saved entry object (null for new curves)
// isNew: true when no saved curve is loaded
// onSave(name, desc): called when saving a new curve
// onUpdate(updatedEntry): called when editing a saved curve's name/desc
// onDirty(): called when name/desc changes on a new (unsaved) curve
function CurveHeader({ entry, isNew, isDirty, initialName, initialDesc, onSave, onUpdate, onDirty }) {
  const [name, setName] = useState(entry?.name ?? initialName ?? '');
  const [desc, setDesc] = useState(entry?.desc ?? initialDesc ?? '');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setName(entry?.name ?? initialName ?? '');
    setDesc(entry?.desc ?? initialDesc ?? '');
  }, [entry?.id]);

  const isExampleOrNew = isNew || entry?.isExample;

  // Saved curves: auto-commit name on blur
  const commitName = () => {
    if (isExampleOrNew) return;
    const trimmed = name.trim();
    if (!trimmed) { setName(entry.name); return; }
    if (trimmed !== entry.name) onUpdate({ ...entry, name: trimmed });
  };

  // Saved curves: auto-commit desc on blur
  const commitDesc = () => {
    if (isExampleOrNew) return;
    if (desc.trim() !== (entry?.desc || '')) onUpdate({ ...entry, desc: desc.trim() });
  };

  const handleSave = () => {
    onSave(name.trim() || 'Untitled', desc.trim());
  };

  const handleShare = () => {
    const encoded = encodeCurve(entry.name, entry.desc, entry.speeds, entry.raceTime, entry.strokeRate);
    const url = `${window.location.origin}${window.location.pathname}#s=${encoded}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <div className="curve-header">
      <div className="curve-header-top">
        <input
          className="curve-header-name"
          value={name}
          onChange={e => { setName(e.target.value); if (isExampleOrNew) onDirty?.(); }}
          onBlur={commitName}
          onKeyDown={e => e.key === 'Enter' && e.target.blur()}
          placeholder="Untitled curve"
        />
        {(isNew || isDirty) && (
          <button className="btn btn-primary btn-save-curve" onClick={handleSave} title="Saved to this browser only">
            Save to browser
          </button>
        )}
        {!isNew && (
          <button
            className={`curve-share-btn${copied ? ' copied' : ''}`}
            onClick={handleShare}
            title="Copy share link"
          >
            {copied ? <span className="share-check">✓ Copied</span> : <ShareIcon />}
          </button>
        )}
      </div>
      <textarea
        className="curve-header-desc"
        value={desc}
        onChange={e => { setDesc(e.target.value); if (isExampleOrNew) onDirty?.(); }}
        onBlur={commitDesc}
        placeholder="Add a description…"
        rows={2}
      />
    </div>
  );
}

export default CurveHeader;
