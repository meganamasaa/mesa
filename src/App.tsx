import React, { useMemo, useRef, useState } from "react";
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

// Normalize all-caps receipt strings ("MOJITO FRESA") to typed-style ("Mojito Fresa").
const toTitleCase = (s: string) =>
  s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());

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
  // Tracks which row's price is currently being edited (so we can show
  // the raw typed string while focused, and "7.50"-formatted while not).
  const [editingPrice, setEditingPrice] = useState<null | { id: string; raw: string }>(null);
  // Same idea for the Tax / Tip fields in Bill Settings.
  const [editingBillField, setEditingBillField] = useState<null | { field: "tax" | "tip"; raw: string }>(null);

  /* Receipt scanning (OpenAI Vision) */
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [scanStatus, setScanStatus] = useState<"idle" | "uploading" | "error">("idle");
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanInfo, setScanInfo] = useState<string | null>(null);

  async function handleReceiptUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-uploading the same file
    if (!file) return;

    setScanStatus("uploading");
    setScanError(null);
    setScanInfo(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/parse-receipt-openai", {
        method: "POST",
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);

      const parsed: Array<{ name: string; price: number; quantity: number }> =
        Array.isArray(data.items) ? data.items : [];

      if (parsed.length === 0) {
        setScanStatus("error");
        setScanError("Couldn't read any items from that image. Try a clearer photo or add manually.");
        return;
      }

      // Append parsed items directly (user can edit inline)
      setItems((prev) => [
        ...prev,
        ...parsed.map((it) => ({
          id: uid(),
          name: toTitleCase(it.name),
          price: Math.max(0, Number(it.price) || 0),
          quantity: Math.max(1, Math.floor(Number(it.quantity) || 1)),
          assignments: [],
        })),
      ]);

      // Auto-fill tax/tip/currency only when fields are still untouched (zero/default)
      setBill((b) => ({
        currency:
          data.detected_currency &&
          ["EUR", "USD", "GBP", "MXN"].includes(data.detected_currency)
            ? (data.detected_currency as Currency)
            : b.currency,
        tax: b.tax > 0 ? b.tax : Number(data.detected_tax) > 0 ? Number(data.detected_tax) : b.tax,
        tip: b.tip > 0 ? b.tip : Number(data.detected_tip) > 0 ? Number(data.detected_tip) : b.tip,
      }));

      const droppedNote =
        typeof data.dropped === "number" && data.dropped > 0
          ? ` (${data.dropped} unreadable row${data.dropped === 1 ? "" : "s"} skipped)`
          : "";
      setScanInfo(`Added ${parsed.length} item${parsed.length === 1 ? "" : "s"} from receipt${droppedNote}.`);
      setScanStatus("idle");
    } catch (err: any) {
      setScanStatus("error");
      setScanError(err?.message || "Failed to parse receipt");
    }
  }

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

  /* Derived totals + validation state (now n cents) */
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
  // Format for clipboard: always show USD first if rate exists.
  // Example: "$24.01 (€35.00)" or "$18.25 (£14.80)"
  const usdFirst = (
    cents: Cents,
    currency: Currency,
    toUsd: (c: Cents) => number | null
  ) => {
    const usdC = toUsd(cents);

    // if we have a conversion rate and base isn't USD
    if (usdC !== null && currency !== "USD") {
      return `${fmt(usdC, "USD")} (${fmt(cents, currency)})`;
    }

    // default fallback (either USD base or no rate yet)
    return fmt(cents, currency);
  };


  function copySummary() {
    const taxC = toCents(bill.tax || 0);
    const tipC = toCents(bill.tip || 0);

    const lines = [
      `Items subtotal: ${usdFirst(itemsSubtotalC, bill.currency, toUsdCents)}`,
      `Tax: ${usdFirst(taxC, bill.currency, toUsdCents)}`,
      `Tip: ${usdFirst(tipC, bill.currency, toUsdCents)} | Split: ${extrasMode}`,
      `Total: ${usdFirst(billTotalC, bill.currency, toUsdCents)}`,
      invalidCount
        ? `⚠ Unallocated items: ${invalidCount} (no people selected: ${invalidUnshared})`
        : "✅ All items allocated",
      "",
      ...people.map((p) => {
        const owedC = totalsByPersonC[p.id] ?? 0;
        return `${p.name}: ${usdFirst(owedC, bill.currency, toUsdCents)}`;
      }),
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

          {/* Scan receipt */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleReceiptUpload}
              style={{ display: "none" }}
            />
            <button
              className="btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={scanStatus === "uploading"}
              title="Upload a photo of a receipt to auto-fill items"
            >
              {scanStatus === "uploading" ? "Scanning…" : "📷 Scan receipt"}
            </button>
            {scanInfo && <span className="hint" style={{ color: "#228B22" }}>{scanInfo}</span>}
            {scanError && <span className="hint" style={{ color: "var(--warn)" }}>{scanError}</span>}
          </div>

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
                  type="text"
                  inputMode="decimal"
                  value={
                    editingPrice?.id === it.id
                      ? editingPrice.raw
                      : (Number.isFinite(it.price) ? it.price : 0).toFixed(2)
                  }
                  onFocus={(e) => {
                    setEditingPrice({ id: it.id, raw: String(it.price) });
                    e.target.select();
                  }}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setEditingPrice({ id: it.id, raw });
                    const n = parseFloat(raw.replace(",", "."));
                    if (Number.isFinite(n) && n >= 0) {
                      updateItem(it.id, { price: n });
                    }
                  }}
                  onBlur={() => setEditingPrice(null)}
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
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={
                    editingBillField?.field === "tax"
                      ? editingBillField.raw
                      : (Number.isFinite(bill.tax) ? bill.tax : 0).toFixed(2)
                  }
                  onFocus={(e) => {
                    setEditingBillField({ field: "tax", raw: String(bill.tax || 0) });
                    e.target.select();
                  }}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setEditingBillField({ field: "tax", raw });
                    const n = parseFloat(raw.replace(",", "."));
                    if (Number.isFinite(n) && n >= 0) {
                      setBill((b) => ({ ...b, tax: n }));
                    }
                  }}
                  onBlur={() => setEditingBillField(null)}
                />
              </label>

              <label className="field">
                <span className="field-label">Tip</span>
                <input
                  className="input"
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={
                    editingBillField?.field === "tip"
                      ? editingBillField.raw
                      : (Number.isFinite(bill.tip) ? bill.tip : 0).toFixed(2)
                  }
                  onFocus={(e) => {
                    setEditingBillField({ field: "tip", raw: String(bill.tip || 0) });
                    e.target.select();
                  }}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setEditingBillField({ field: "tip", raw });
                    const n = parseFloat(raw.replace(",", "."));
                    if (Number.isFinite(n) && n >= 0) {
                      setBill((b) => ({ ...b, tip: n }));
                    }
                  }}
                  onBlur={() => setEditingBillField(null)}
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

              {/* Tax */}
              <div className="row-line">
                <span>Tax</span>
                <div style={{ textAlign: "right" }}>
                  <strong>{fmt(toCents(bill.tax || 0), bill.currency)}</strong>
                  {toUsdCents(toCents(bill.tax || 0)) !== null && bill.currency !== "USD" && (
                    <div className="fx-hint">
                      ≈ {fmt(toUsdCents(toCents(bill.tax || 0))!, "USD")} USD
                    </div>
                  )}
                </div>
              </div>

              {/* Tip */}
              <div className="row-line">
                <span>Tip</span>
                <div style={{ textAlign: "right" }}>
                  <strong>{fmt(toCents(bill.tip || 0), bill.currency)}</strong>
                  {toUsdCents(toCents(bill.tip || 0)) !== null && bill.currency !== "USD" && (
                    <div className="fx-hint">
                      ≈ {fmt(toUsdCents(toCents(bill.tip || 0))!, "USD")} USD
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

          {/* Allocation validation readout  */}
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: Math.abs(allocationDeltaC) < 1 ? "#228B22" : "#fde68a", // <1 cent ~ OK
            }}
          >
            {Math.abs(allocationDeltaC) < 1 ? (
              <>Allocation check: allocated {fmt(allocatedFoodC, bill.currency)} of {fmt(itemsSubtotalC, bill.currency)} ✅</>
            ) : (
              <>Allocation check : allocated {fmt(allocatedFoodC, bill.currency)} of {fmt(itemsSubtotalC, bill.currency)} — off by {fmt(allocationDeltaC, bill.currency)} ⚠</>
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
