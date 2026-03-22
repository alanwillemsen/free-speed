function Controls({ onReset }) {
  return (
    <div className="controls">
      <h2>Curve Controls</h2>
      <div className="control-buttons">
        <button className="btn btn-secondary" onClick={onReset}>
          Reset Crew B
        </button>
      </div>
    </div>
  );
}

export default Controls;
