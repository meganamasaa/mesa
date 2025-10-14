import React, { useMemo, useState } from "react";
import "./styles.css";

/* ========= Types & utils ========= */
type Person = { id: string; name: string };

type ItemAssignment = { personId: string; quantity: number }; // quantity kept for forward-compat
type Item = {
  id: string;
  name: string;
  price: number;                 // per-unit price (decimal, user-entered)
  quantity: number;              // editable; total = price * quantity
  assignments: ItemAssignment[]; // presence => shares equally
};

type Currency = "EUR" | "USD" | "GBP" | "MXN";
type Bill = { tax: number; tip: number; currency: Currency };
type ExtrasSplitMode = "equal" | "proportional";

/* ========= Helpers ========= */
const uid = () => Math.random().toString(36).slice(2, 9);

// money formatting (rendering)
const money = (n: number, c: Currency = "EUR") =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: c }).format(n);

/** Cents helpers — do all math in integer cents to avoid floating-point drift */
type Cents = number;
const toCents = (n: number): Cents => Math.round(n * 100);
const fromCents = (c: Cents): number => c / 100;
const fmt = (c: Cents, currency: Currency = "EUR") =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(fromCents(c));

// === Live USD conversion (hourly) ===
// === Live USD conversion (hourly) — using open.er-api.com (no API key required) ===
function useUsdRate(base: Currency) {
  const [rate, setRate] = React.useState<number | null>(base === "USD" ? 1 : null);
  const [updatedAt, setUpdatedAt] = React.useState<Date | null>(null);
  const [status, setStatus] = React.useState<"idle" | "loading" | "ok" | "error">("idle");
  const baseRef = React.useRef<Currency>(base);

  // Fetch the live exchange rate for this base currency → USD
  const fetchRate = React.useCallback(async () => {
    setStatus("loading");

    // trivial case
    if (base === "USD") {
      setRate(1);
      setUpdatedAt(new Date());
      baseRef.current = base;
      setStatus("ok");
      return;
    }

    try {
      const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // "result": "success" → valid data
      if (data?.result !== "success" || !data?.rates?.USD) throw new Error("Invalid response");

      const next = Number(data.rates.USD);
      if (!Number.isFinite(next) || next <= 0) throw new Error("Bad rate");

      setRate(next);
      setUpdatedAt(new Date());
      baseRef.current = base;
      setStatus("ok");
    } catch (err) {
      console.error("FX fetch failed:", err);
      setStatus("error");
      if (baseRef.current !== base) setRate(null);
    }
  }, [base]);

  // Auto-refresh every hour, and whenever base changes
  React.useEffect(() => {
    if (base !== "USD") setRate(null);
    fetchRate();
    const timer = window.setInterval(fetchRate, 60 * 60 * 1000); // every hour
    return () => window.clearInterval(timer);
  }, [base, fetchRate]);

  return { rateToUSD: rate, updatedAt, status, refresh: fetchRate };
}


/* ========= Core math in cents ========= */
/** Compute per-person pre-extras totals and items subtotal, in cents. */
function computePerPersonPreExtrasCents(people: Person[], items: Item[]) {
  const totalsC: Record<string, number> = Object.fromEntries(people.map((p) => [p.id, 0]));
  let itemsSubtotalC = 0;

  // validation: items with no people selected
  let invalidUnshared = 0;

  for (const it of items) {
    const lineTotalC = toCents(it.price * it.quantity);
    itemsSubtotalC += lineTotalC;

    const assignedIds = it.assignments.map((a) => a.personId);
    const shareCount = assignedIds.length;

    if (shareCount === 0) {
      invalidUnshared += 1;
      continue;
    }

    // equal split with remainder distribution to first r assignees
    const q = Math.floor(lineTotalC / shareCount);
    let r = lineTotalC % shareCount;
    assignedIds.forEach((pid, idx) => {
      totalsC[pid] += q + (idx < r ? 1 : 0);
    });
  }

  const invalidCount = invalidUnshared;
  return { perPersonPreExtrasC: totalsC, itemsSubtotalC, invalidUnshared, invalidCount };
}

/* ========= App ========= */
export default function App() {
  /* People */
  const [people, setPeople] = useState<Person[]>([
    { id: uid(), name: "You" },
    { id: uid(), name: "Friend" },
  ]);
  const [newName, setNewName] = useState("");

  function addPerson() {
    const name = newName.trim();
    if (!name) return;
    setPeople((ps) => [...ps, { id: uid(), name }]);
    setNewName("");
  }
  function removePerson(id: string) {
    setPeople((ps) => ps.filter((p) => p.id !== id));
    // scrub assignments for that person from all items
    setItems((prev) =>
      prev.map((it) => ({
        ...it,
        assignments: it.assignments.filter((a) => a.personId !== id),
      }))
    );
  }

  /* Items */
  const [items, setItems] = useState<Item[]>([]);
  const [draftName, setDraftName] = useState("");
  const [draftPrice, setDraftPrice] = useState("");
  const [draftQty, setDraftQty] = useState(""); // blank to start; defaults to 1 on add
  const [undo, setUndo] = useState<null | { item: Item; index: number }>(null);

  function addItem() {
    const name = draftName.trim();
    const price = parseFloat(draftPrice.replace(",", ".")); // tolerant parsing
    const qty = Math.max(1, parseInt(draftQty || "1", 10));
    if (!name) return;
    if (!Number.isFinite(price) || price < 0) return;
    setItems((prev) => [
      ...prev,
      { id: uid(), name, price, quantity: qty, assignments: [] },
    ]);
    setDraftName("");
    setDraftPrice("");
    setDraftQty("");
  }
  function onDraftKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") addItem();
    if (e.key === "Escape") {
      setDraftName("");
      setDraftPrice("");
      setDraftQty("");
    }
  }
  function updateItem(id: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }
  function removeItem(id: string) {
    setItems((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      if (idx === -1) return prev;
      const removed = prev[idx];
      setUndo({ item: removed, index: idx });
      const copy = prev.slice();
      copy.splice(idx, 1);
      return copy;
    });
  }
  function undoDelete() {
    if (!undo) return;
    setItems((prev) => {
      const copy = prev.slice();
      copy.splice(undo.index, 0, undo.item);
      return copy;
    });
    setUndo(null);
  }

  /* Assignments (v3: toggle membership; split always equal among checked) */
  function toggleAssign(itemId: string, personId: string) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== itemId) return it;
        const exists = it.assignments.some((a) => a.personId === personId);
        return exists
          ? { ...it, assignments: it.assignments.filter((a) => a.personId !== personId) }
          : { ...it, assignments: [...it.assignments, { personId, quantity: 1 }] };
      })
    );
  }

  /* Bill + extras split mode */
  const [bill, setBill] = useState<Bill>({ tax: 0, tip: 0, currency: "EUR" });
  const [extrasMode, setExtrasMode] = useState<ExtrasSplitMode>("equal"); // default: socially fair

  /* Derived totals + validation state (now in cents) */
  const {
    perPersonPreExtrasC,
    itemsSubtotalC,
    invalidUnshared,
    invalidCount,
  } = useMemo(() => computePerPersonPreExtrasCents(people, items), [people, items]);

  const totalsByPersonC = useMemo(() => {
    // Start with food totals (cents)
    const totals: Record<string, number> = { ...perPersonPreExtrasC };
    const taxC = toCents(Number.isFinite(bill.tax) ? bill.tax : 0);
    const tipC = toCents(Number.isFinite(bill.tip) ? bill.tip : 0);
    const extrasC = taxC + tipC;

    if (extrasC <= 0 || people.length === 0) return totals;

    if (extrasMode === "equal") {
      const q = Math.floor(extrasC / people.length);
      let r = extrasC % people.length;
      people.forEach((p, idx) => {
        totals[p.id] = (totals[p.id] ?? 0) + q + (idx < r ? 1 : 0);
      });
      return totals;
    }

    // proportional: distribute by pre-extras weight
    const preSumC = Object.values(perPersonPreExtrasC).reduce((a, b) => a + b, 0);
    if (preSumC <= 0) {
      const q = Math.floor(extrasC / people.length);
      let r = extrasC % people.length;
      people.forEach((p, idx) => (totals[p.id] = (totals[p.id] ?? 0) + q + (idx < r ? 1 : 0)));
      return totals;
    }

    // provisional shares in cents
    const provisional: number[] = people.map((p) =>
      Math.floor((extrasC * (perPersonPreExtrasC[p.id] ?? 0)) / preSumC)
    );
    const given = provisional.reduce((a, b) => a + b, 0);
    let rem = extrasC - given;

    // assign remainder to biggest pre-extras weights first (deterministic)
    const order = [...people]
      .map((p, i) => ({ i, w: perPersonPreExtrasC[p.id] ?? 0 }))
      .sort((a, b) => b.w - a.w || a.i - b.i)
      .map((o) => o.i);

    order.forEach((idx) => {
      if (rem > 0) {
        provisional[idx] += 1;
        rem -= 1;
      }
    });

    people.forEach((p, i) => {
      totals[p.id] = (totals[p.id] ?? 0) + provisional[i];
    });
    return totals;
  }, [people, perPersonPreExtrasC, bill.tax, bill.tip, extrasMode]);

  const billTotalC = useMemo(() => {
    const taxC = toCents(bill.tax || 0);
    const tipC = toCents(bill.tip || 0);
    return itemsSubtotalC + taxC + tipC;
  }, [itemsSubtotalC, bill.tax, bill.tip]);

  // Allocation delta (food only)
  const allocatedFoodC = useMemo(
    () => Object.values(perPersonPreExtrasC).reduce((a, b) => a + b, 0),
    [perPersonPreExtrasC]
  );
  const allocationDeltaC = useMemo(
    () => itemsSubtotalC - allocatedFoodC,
    [itemsSubtotalC, allocatedFoodC]
  );

    // Live USD rate for the currently selected bill currency
  const { rateToUSD, updatedAt, status: fxStatus } = useUsdRate(bill.currency);

  // Convert cents in current currency -> USD cents (round safely)
  const toUsdCents = React.useCallback(
    (cents: number) => {
      if (!rateToUSD) return null;
      // cents_in_usd = round(cents * rate)
      return Math.round(cents * rateToUSD);
    },
    [rateToUSD]
  );


  function copySummary() {
    const lines = [
      `Items subtotal: ${fmt(itemsSubtotalC, bill.currency)}`,
      `Tax: ${fmt(toCents(bill.tax || 0), bill.currency)} | Tip: ${fmt(
        toCents(bill.tip || 0),
        bill.currency
      )} | Mode: ${extrasMode}`,
      `Total: ${fmt(billTotalC, bill.currency)}`,
      invalidCount
        ? `⚠ Unallocated items: ${invalidCount} (no people selected: ${invalidUnshared})`
        : "✅ All items allocated",
      "",
      ...people.map(
        (p) => `${p.name}: ${fmt(totalsByPersonC[p.id] ?? 0, bill.currency)}`
      ),
    ];
    navigator.clipboard.writeText(lines.join("\n")).catch(() => {});
  }

  /* ========= Render ========= */
  return (
    <div className="page">
      <div className="card">
        <h1 className="title">🪑 Mesa — v3</h1>

        {/* People */}
        <section className="section">
          <h2 className="h2">People</h2>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input
              className="input"
              placeholder="Add a name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addPerson()}
            />
            <button className="btn" onClick={addPerson}>Add</button>
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {people.map((p) => (
              <li key={p.id} className="row">
                <span>{p.name}</span>
                <button className="link-btn" onClick={() => removePerson(p.id)}>remove</button>
              </li>
            ))}
          </ul>
        </section>

        {/* Items editor */}
        <section className="section">
          <h2 className="h2">Items</h2>
          {items.length === 0 && !draftName && !draftPrice && !draftQty && (
            <p style={{ marginTop: 6, fontSize: 13, color: "#9CA3AF" }}>
              e.g. <em>Sushi — 12.00 × 2</em>, then press Enter or click + Add
            </p>
          )}

          {/* Draft row: name | price | qty | +Add */}
          <div className="grid-draft">
            <div>
              <label className="label">Item name</label>
              <input
                className="input"
                value={draftName}
                placeholder="Sushi"
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={onDraftKeyDown}
              />
            </div>
            <div>
              <label className="label">Price (€)</label>
              <input
                className="input"
                value={draftPrice}
                inputMode="decimal"
                placeholder="12.00"
                onChange={(e) => setDraftPrice(e.target.value)}
                onKeyDown={onDraftKeyDown}
              />
            </div>
            <div>
              <label className="label">Qty</label>
              <input
                className="input"
                value={draftQty}
                inputMode="numeric"
                placeholder="2"
                onChange={(e) =>
                  setDraftQty(String(Math.max(1, parseInt(e.target.value || "1", 10))))
                }
                onKeyDown={onDraftKeyDown}
              />
            </div>
            <button className="btn w-full" onClick={addItem}>+ Add</button>
          </div>

          {/* Items list rows: name | price | qty | 🗑️ */}
          <ul className="items-list">
            {items.map((it) => (
              <li key={it.id} className="item-row">
                <input
                  className="input"
                  value={it.name}
                  onChange={(e) => updateItem(it.id, { name: e.target.value })}
                />
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  min="0"
                  value={Number.isFinite(it.price) ? it.price : 0}
                  onChange={(e) =>
                    updateItem(it.id, {
                      price: Math.max(0, parseFloat((e.target.value || "0").replace(",", "."))),
                    })
                  }
                />
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={it.quantity}
                  onChange={(e) =>
                    updateItem(it.id, {
                      quantity: Math.max(1, parseInt(e.target.value || "1", 10)),
                    })
                  }
                />
                <button
                  aria-label="Remove item"
                  title="Remove item"
                  className="icon-btn"
                  onClick={() => removeItem(it.id)}
                >
                  🗑️
                </button>
              </li>
            ))}
          </ul>

          {/* Undo bar */}
          {undo && (
            <div className="undo-bar">
              Removed “{undo.item.name}”.{" "}
              <button className="link-btn" onClick={undoDelete}>Undo</button>
            </div>
          )}
        </section>

        {/* Bill Settings (structured card) */}
        <section className="section">
          <h2 className="h2">Bill Settings</h2>
          <div className="bill-card">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
              <label className="field">
                <span className="field-label">Currency</span>
                <select
                  className="input"
                  value={bill.currency}
                  onChange={(e) =>
                    setBill((b) => ({ ...b, currency: e.target.value as Currency }))
                  }
                >
                  {(["EUR", "USD", "GBP", "MXN"] as Currency[]).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span className="field-label">Tax</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={bill.tax}
                  onChange={(e) =>
                    setBill((b) => ({
                      ...b,
                      tax: Math.max(0, parseFloat((e.target.value || "0").replace(",", "."))),
                    }))
                  }
                />
              </label>

              <label className="field">
                <span className="field-label">Tip</span>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={bill.tip}
                  onChange={(e) =>
                    setBill((b) => ({
                      ...b,
                      tip: Math.max(0, parseFloat((e.target.value || "0").replace(",", "."))),
                    }))
                  }
                />
              </label>
            </div>

            <div style={{ marginTop: 12 }}>
              <span className="field-label">Split tax & tip</span>
              <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="extrasmode"
                    checked={extrasMode === "equal"}
                    onChange={() => setExtrasMode("equal")}
                  />
                  <span>Equally</span>
                </label>
                <label className="radio-label">
                  <input
                    type="radio"
                    name="extrasmode"
                    checked={extrasMode === "proportional"}
                    onChange={() => setExtrasMode("proportional")}
                  />
                  <span>Proportionally</span>
                </label>
              </div>
            </div>

            {/* === Bill summary with USD conversion === */}
            <div className="summary-box" style={{ marginTop: 12 }}>
              {/* Items subtotal */}
              <div className="row-line">
                <span>Items subtotal</span>
                <div style={{ textAlign: "right" }}>
                  <strong>{fmt(itemsSubtotalC, bill.currency)}</strong>
                  {toUsdCents(itemsSubtotalC) !== null && bill.currency !== "USD" && (
                    <div className="fx-hint">≈ {fmt(toUsdCents(itemsSubtotalC)!, "USD")} USD</div>
                  )}
                </div>
              </div>

              {/* Tax + Tip */}
              <div className="row-line">
                <span>Tax + Tip</span>
                <div style={{ textAlign: "right" }}>
                  <strong>
                    {fmt(toCents(bill.tax || 0) + toCents(bill.tip || 0), bill.currency)}
                  </strong>
                  {toUsdCents(toCents((bill.tax || 0) + (bill.tip || 0))) !== null &&
                    bill.currency !== "USD" && (
                      <div className="fx-hint">
                        ≈ {fmt(toUsdCents(toCents((bill.tax || 0) + (bill.tip || 0)))!, "USD")} USD
                      </div>
                    )}
                </div>
              </div>

              {/* Grand total */}
              <div className="row-line" style={{ marginTop: 6, fontWeight: 700 }}>
                <span>Total</span>
                <div style={{ textAlign: "right" }}>
                  <strong>{fmt(billTotalC, bill.currency)}</strong>
                  {toUsdCents(billTotalC) !== null && bill.currency !== "USD" && (
                    <div className="fx-hint">≈ {fmt(toUsdCents(billTotalC)!, "USD")} USD</div>
                  )}
                </div>
              </div>

              {/* Small FX status line */}
              {bill.currency !== "USD" && (
                <div className="hint" style={{ marginTop: 6 }}>
                  FX:{" "}
                  {fxStatus === "loading"
                    ? "Updating…"
                    : fxStatus === "error"
                    ? "Using last known rate (update failed)"
                    : "Live"}
                  {updatedAt && ` • ${updatedAt.toLocaleTimeString()}`}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Assign grid (receipt-style checkboxes) */}
        <section className="section">
          <h2 className="h2">Assign</h2>

          <div className="scroll-x">
            <table className="assign-table">
              <thead className="assign-thead">
                <tr>
                  <th className="th">Item</th>
                  <th className="th">Price</th>
                  <th className="th">Qty</th>
                  {people.map((p) => (
                    <th key={p.id} className="th">{p.name}</th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {items.map((it) => (
                  <tr key={it.id}>
                    <td className="td">
                      <div style={{ fontWeight: 600 }}>{it.name}</div>

                      <div style={{ display: "inline-flex", gap: 8, marginTop: 6 }}>
                        <button
                          className="link-btn"
                          onClick={() =>
                            setItems((prev) =>
                              prev.map((row) =>
                                row.id === it.id
                                  ? {
                                      ...row,
                                      assignments: people.map((p) => ({
                                        personId: p.id,
                                        quantity: 1,
                                      })),
                                    }
                                  : row
                              )
                            )
                          }
                        >
                          All
                        </button>
                        <button
                          className="link-btn"
                          onClick={() =>
                            setItems((prev) =>
                              prev.map((row) =>
                                row.id === it.id ? { ...row, assignments: [] } : row
                              )
                            )
                          }
                        >
                          None
                        </button>
                        {it.assignments.length === 0 && (
                          <span className="hint">Select who shared this ↑</span>
                        )}
                      </div>
                    </td>

                    <td className="td">{money(it.price, bill.currency)}</td>
                    <td className="td">x{it.quantity}</td>

                    {people.map((p) => {
                      const active = it.assignments.some((a) => a.personId === p.id);
                      return (
                        <td key={p.id} className="td" style={{ textAlign: "center" }}>
                          <input
                            type="checkbox"
                            className="assign-checkbox"
                            checked={active}
                            onChange={() => toggleAssign(it.id, p.id)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {invalidCount > 0 && (
            <div className="banner-warn">
              ⚠ Some items have no people selected ({invalidUnshared}). Totals may be off
              until all items are allocated.
            </div>
          )}
        </section>


        {/* Settlement */}
        <section className="section">
          <h2 className="h2">Settlement</h2>
            {/* === Settlement with USD equivalents === */}
            <ul style={{ listStyle: "none", padding: 0, marginTop: 8 }}>
              {people.map((p) => {
                const owedC = totalsByPersonC[p.id] ?? 0;
                const owedUsdC = toUsdCents(owedC);
                return (
                  <li key={p.id} className="row-line">
                    <span>{p.name}</span>
                    <div style={{ textAlign: "right" }}>
                      <strong>{fmt(owedC, bill.currency)}</strong>
                      {owedUsdC !== null && bill.currency !== "USD" && (
                        <div className="fx-hint">≈ {fmt(owedUsdC, "USD")} USD</div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

          {/* Allocation validation readout (food only) */}
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: Math.abs(allocationDeltaC) < 1 ? "#86efac" : "#fde68a", // <1 cent ~ OK
            }}
          >
            {Math.abs(allocationDeltaC) < 1 ? (
              <>Allocation check (food only): allocated {fmt(allocatedFoodC, bill.currency)} of {fmt(itemsSubtotalC, bill.currency)} ✅</>
            ) : (
              <>Allocation check (food only): allocated {fmt(allocatedFoodC, bill.currency)} of {fmt(itemsSubtotalC, bill.currency)} — off by {fmt(allocationDeltaC, bill.currency)} ⚠</>
            )}
          </div>

          <div style={{ marginTop: 8 }}>
            <button
              className="btn"
              style={{
                opacity: invalidCount > 0 || Math.abs(allocationDeltaC) >= 1 ? 0.6 : 1,
                cursor:
                  invalidCount > 0 || Math.abs(allocationDeltaC) >= 1
                    ? "not-allowed"
                    : "pointer",
              }}
              disabled={invalidCount > 0 || Math.abs(allocationDeltaC) >= 1}
              title={
                invalidCount > 0 || Math.abs(allocationDeltaC) >= 1
                  ? "Finish allocations before copying summary"
                  : "Copy summary"
              }
              onClick={copySummary}
            >
              Copy summary
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
