/* Mahlzeiten-Rechner v1 — static, localStorage, OFF + Tesseract */
(() => {
  "use strict";

  const STORAGE_KEY = "mahlzeiten_rechner_v1";
  const HISTORY_DAYS = 7;

  const DEFAULT_GOALS = { kcal: 2200, protein: 160, carbs: 200, fat: 70 };

  const TITLES = {
    heute: "Heute",
    add: "Hinzufügen",
    verlauf: "Verlauf",
    ziele: "Ziele",
  };

  /** @type {{ goals: typeof DEFAULT_GOALS, entries: Entry[] }} */
  let state = loadState();

  /** @typedef {{
   *   id: string,
   *   date: string,
   *   createdAt: string,
   *   name: string,
   *   grams: number,
   *   per100: { kcal: number, protein: number, carbs: number, fat: number },
   *   totals: { kcal: number, protein: number, carbs: number, fat: number },
   *   source: string,
   *   barcode?: string
   * }} Entry */

  let html5QrCode = null;
  let ocrAbort = false;
  let pendingSource = "manual";

  // —— DOM ——
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const viewTitle = $("#viewTitle");
  const toastEl = $("#toast");
  const panels = {
    heute: $("#panel-heute"),
    add: $("#panel-add"),
    verlauf: $("#panel-verlauf"),
    ziele: $("#panel-ziele"),
  };

  const scanSheet = $("#scanSheet");
  const previewSheet = $("#previewSheet");
  const ocrSheet = $("#ocrSheet");
  const ocrFileInput = $("#ocrFileInput");

  // —— Storage ——
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { goals: { ...DEFAULT_GOALS }, entries: [] };
      const parsed = JSON.parse(raw);
      return {
        goals: { ...DEFAULT_GOALS, ...(parsed.goals || {}) },
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    } catch {
      return { goals: { ...DEFAULT_GOALS }, entries: [] };
    }
  }

  function saveState() {
    // prune old entries beyond HISTORY_DAYS
    const cutoff = dayOffset(-HISTORY_DAYS + 1);
    state.entries = state.entries.filter((e) => e.date >= cutoff);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ goals: state.goals, entries: state.entries })
    );
  }

  function todayStr(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function dayOffset(n) {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + n);
    return todayStr(d);
  }

  function uid() {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function num(v, fallback = 0) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (v == null || v === "") return fallback;
    const s = String(v).replace(",", ".").replace(/[^\d.+-]/g, "");
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : fallback;
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function fmt(n, digits = 0) {
    const x = Number(n) || 0;
    return x.toLocaleString("de-DE", {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits > 0 && x % 1 !== 0 ? Math.min(digits, 1) : 0,
    });
  }

  function scaleMacros(per100, grams) {
    const f = grams / 100;
    return {
      kcal: round1(per100.kcal * f),
      protein: round1(per100.protein * f),
      carbs: round1(per100.carbs * f),
      fat: round1(per100.fat * f),
    };
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove("show"), 2800);
  }

  // —— Navigation ——
  function showPanel(name) {
    Object.entries(panels).forEach(([k, el]) => {
      el.classList.toggle("active", k === name);
    });
    $$(".nav-item").forEach((btn) => {
      const on = btn.dataset.panel === name;
      btn.classList.toggle("is-active", on);
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    viewTitle.textContent = TITLES[name] || name;
    if (name === "heute") renderHeute();
    if (name === "verlauf") renderHistory();
    if (name === "ziele") fillGoalsForm();
  }

  $$(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => showPanel(btn.dataset.panel));
  });
  $("#btnNavAdd").addEventListener("click", () => showPanel("add"));

  // —— Goals ——
  function fillGoalsForm() {
    $("#goalKcal").value = state.goals.kcal;
    $("#goalProtein").value = state.goals.protein;
    $("#goalCarbs").value = state.goals.carbs;
    $("#goalFat").value = state.goals.fat;
  }

  $("#goalsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    state.goals = {
      kcal: num($("#goalKcal").value, DEFAULT_GOALS.kcal),
      protein: num($("#goalProtein").value, DEFAULT_GOALS.protein),
      carbs: num($("#goalCarbs").value, DEFAULT_GOALS.carbs),
      fat: num($("#goalFat").value, DEFAULT_GOALS.fat),
    };
    saveState();
    toast("Ziele gespeichert");
    showPanel("heute");
  });

  // —— Render Heute ——
  function todayEntries() {
    const t = todayStr();
    return state.entries.filter((e) => e.date === t).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  function sumEntries(list) {
    return list.reduce(
      (acc, e) => ({
        kcal: acc.kcal + (e.totals?.kcal || 0),
        protein: acc.protein + (e.totals?.protein || 0),
        carbs: acc.carbs + (e.totals?.carbs || 0),
        fat: acc.fat + (e.totals?.fat || 0),
      }),
      { kcal: 0, protein: 0, carbs: 0, fat: 0 }
    );
  }

  function toneFor(sum, goal) {
    if (!goal || goal <= 0) return "neutral";
    const pct = sum / goal;
    if (pct > 1.02) return "over";
    if (pct >= 0.9) return "warn";
    return "ok";
  }

  function restLabel(sum, goal, unit) {
    if (!goal || goal <= 0) return "Kein Ziel";
    const diff = goal - sum;
    if (Math.abs(diff) < 0.05) return `Genau am Ziel`;
    if (diff > 0) return `Rest ${fmt(diff, unit === "kcal" ? 0 : 1)} ${unit}`;
    return `Überschuss ${fmt(Math.abs(diff), unit === "kcal" ? 0 : 1)} ${unit}`;
  }

  function updateMacroTile(key, sum, goal, unit) {
    const tile = $(`.macro-tile[data-macro="${key}"]`);
    const tone = toneFor(sum, goal);
    tile.dataset.tone = tone;
    const digits = unit === "kcal" ? 0 : 1;
    const idMap = { kcal: "Kcal", protein: "Protein", carbs: "Carbs", fat: "Fat" };
    const id = idMap[key];
    $(`#sum${id}`).textContent = fmt(sum, digits);
    $(`#goal${id}Label`).textContent = `Ziel ${fmt(goal, digits)} ${unit}`;
    $(`#rest${id}`).textContent = restLabel(sum, goal, unit);
    const pct = goal > 0 ? Math.min(100, (sum / goal) * 100) : 0;
    $(`#bar${id}`).style.width = `${pct}%`;
  }

  function renderHeute() {
    const list = todayEntries();
    const sum = sumEntries(list);
    const g = state.goals;
    updateMacroTile("kcal", sum.kcal, g.kcal, "kcal");
    updateMacroTile("protein", sum.protein, g.protein, "g");
    updateMacroTile("carbs", sum.carbs, g.carbs, "g");
    updateMacroTile("fat", sum.fat, g.fat, "g");

    const note = $("#statusNote");
    const text = $("#statusText");
    const tones = ["kcal", "protein", "carbs", "fat"].map((k) =>
      toneFor(sum[k], g[k])
    );
    if (list.length === 0) {
      note.dataset.tone = "neutral";
      text.textContent = "Noch nichts erfasst – + tippen zum Scannen oder Eintragen.";
    } else if (tones.includes("over")) {
      note.dataset.tone = "over";
      text.textContent = "Mindestens ein Makro über dem Ziel – Rest der anderen im Blick behalten.";
    } else if (tones.every((t) => t === "ok" || t === "warn")) {
      note.dataset.tone = tones.includes("warn") ? "warn" : "ok";
      text.textContent = tones.includes("warn")
        ? "Nahe am Ziel – Rest / Überschuss in den Kacheln."
        : "Alles im Rahmen der Ziele. Weiter so.";
    } else {
      note.dataset.tone = "neutral";
      text.textContent = `${list.length} Eintrag${list.length === 1 ? "" : "e"} heute.`;
    }

    const empty = $("#todayEmpty");
    const ul = $("#todayList");
    if (list.length === 0) {
      empty.hidden = false;
      ul.innerHTML = "";
    } else {
      empty.hidden = true;
      ul.innerHTML = list.map(entryHtml).join("");
      bindEntryActions(ul);
    }
  }

  function entryHtml(e) {
    return `<li class="entry-item" data-id="${e.id}">
      <div>
        <div class="name">${escapeHtml(e.name)}</div>
        <div class="meta">${fmt(e.grams, 0)} g · ${sourceLabel(e.source)}</div>
      </div>
      <div class="macros">${fmt(e.totals.kcal, 0)} kcal<br>${fmt(e.totals.protein, 1)} P · ${fmt(e.totals.carbs, 1)} KH · ${fmt(e.totals.fat, 1)} F</div>
      <div class="entry-actions">
        <button type="button" class="btn btn-sm btn-danger" data-del="${e.id}">Löschen</button>
      </div>
    </li>`;
  }

  function sourceLabel(s) {
    if (s === "barcode") return "Barcode";
    if (s === "ocr") return "OCR";
    return "Manuell";
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function bindEntryActions(root) {
    root.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-del");
        state.entries = state.entries.filter((e) => e.id !== id);
        saveState();
        toast("Eintrag gelöscht");
        renderHeute();
        renderHistory();
      });
    });
  }

  // —— History ——
  function renderHistory() {
    const root = $("#historyRoot");
    const empty = $("#historyEmpty");
    if (!state.entries.length) {
      empty.hidden = false;
      root.innerHTML = "";
      return;
    }
    empty.hidden = true;
    const byDay = {};
    state.entries.forEach((e) => {
      (byDay[e.date] ||= []).push(e);
    });
    const days = Object.keys(byDay).sort((a, b) => (a < b ? 1 : -1));
    root.innerHTML = days
      .map((day) => {
        const items = byDay[day].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        const sum = sumEntries(items);
        const label = day === todayStr() ? "Heute" : formatDayDe(day);
        return `<section class="card day-group">
          <h3>${label} · ${fmt(sum.kcal, 0)} kcal</h3>
          <ul class="entries-list">${items.map(entryHtml).join("")}</ul>
        </section>`;
      })
      .join("");
    bindEntryActions(root);
  }

  function formatDayDe(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString("de-DE", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  }

  // —— Preview sheet ——
  function openPreview(data) {
    pendingSource = data.source || "manual";
    if (data.barcode) $("#sourceBadge").dataset.barcode = data.barcode;
    else delete $("#sourceBadge").dataset.barcode;
    $("#sourceBadge").textContent =
      pendingSource === "barcode"
        ? `Barcode${data.barcode ? " · " + data.barcode : ""} · Open Food Facts`
        : pendingSource === "ocr"
          ? "OCR · bitte korrigieren"
          : "Manuell";
    $("#prodName").value = data.name || "";
    $("#nutKcal").value = round1(num(data.kcal));
    $("#nutProtein").value = round1(num(data.protein));
    $("#nutCarbs").value = round1(num(data.carbs));
    $("#nutFat").value = round1(num(data.fat));
    $("#gramsEaten").value = data.grams || 100;
    updateScaledPreview();
    if (!previewSheet.open) previewSheet.showModal();
  }

  function updateScaledPreview() {
    const per100 = {
      kcal: num($("#nutKcal").value),
      protein: num($("#nutProtein").value),
      carbs: num($("#nutCarbs").value),
      fat: num($("#nutFat").value),
    };
    const grams = num($("#gramsEaten").value, 100);
    const t = scaleMacros(per100, grams);
    $("#scaledText").textContent = `${fmt(t.kcal, 0)} kcal · ${fmt(t.protein, 1)} g P · ${fmt(t.carbs, 1)} g KH · ${fmt(t.fat, 1)} g F`;
  }

  ["nutKcal", "nutProtein", "nutCarbs", "nutFat", "gramsEaten"].forEach((id) => {
    $(`#${id}`).addEventListener("input", updateScaledPreview);
  });

  $("#previewCancel").addEventListener("click", () => previewSheet.close());
  previewSheet.addEventListener("close", () => {});

  $("#previewForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#prodName").value.trim() || "Unbenannt";
    const per100 = {
      kcal: num($("#nutKcal").value),
      protein: num($("#nutProtein").value),
      carbs: num($("#nutCarbs").value),
      fat: num($("#nutFat").value),
    };
    const grams = Math.max(1, num($("#gramsEaten").value, 100));
    const totals = scaleMacros(per100, grams);
    const entry = {
      id: uid(),
      date: todayStr(),
      createdAt: new Date().toISOString(),
      name,
      grams,
      per100,
      totals,
      source: pendingSource,
      barcode: pendingSource === "barcode" ? ($("#sourceBadge").dataset.barcode || undefined) : undefined,
    };
    state.entries.push(entry);
    saveState();
    previewSheet.close();
    toast("Zur Tages-Summe hinzugefügt");
    showPanel("heute");
  });

  // —— Manual ——
  $("#btnManual").addEventListener("click", () => {
    openPreview({
      source: "manual",
      name: "",
      kcal: 0,
      protein: 0,
      carbs: 0,
      fat: 0,
      grams: 100,
    });
  });

  // —— Barcode / OFF ——
  $("#btnScanBarcode").addEventListener("click", startBarcodeScan);
  $("#scanCancel").addEventListener("click", stopBarcodeScan);

  async function startBarcodeScan() {
    if (typeof Html5Qrcode === "undefined") {
      toast("Scanner-Bibliothek noch nicht geladen");
      return;
    }
    scanSheet.showModal();
    $("#scanHint").textContent = "Kamera ausrichten – Code wird automatisch erkannt.";
    try {
      html5QrCode = new Html5Qrcode("qr-reader");
      await html5QrCode.start(
        { facingMode: "environment" },
        { fps: 8, qrbox: { width: 260, height: 140 }, aspectRatio: 1.777 },
        onScanSuccess,
        () => {}
      );
    } catch (err) {
      console.error(err);
      $("#scanHint").textContent =
        "Kamera nicht verfügbar. HTTPS + Kamerazugriff nötig. Du kannst manuell oder per OCR fortfahren.";
      toast("Kamera fehlgeschlagen");
    }
  }

  let stoppingScan = false;
  async function stopBarcodeScan() {
    if (stoppingScan) return;
    stoppingScan = true;
    try {
      if (html5QrCode) {
        try {
          const st = html5QrCode.getState && html5QrCode.getState();
          // 2 = SCANNING, 3 = PAUSED in html5-qrcode
          if (st === 2 || st === 3) await html5QrCode.stop();
        } catch (_) {}
        try { await html5QrCode.clear(); } catch (_) {}
      }
    } catch (_) {}
    html5QrCode = null;
    if (scanSheet.open) scanSheet.close();
    stoppingScan = false;
  }

  scanSheet.addEventListener("close", () => {
    if (!stoppingScan) stopBarcodeScan();
  });

  let lastCode = "";
  let lastCodeAt = 0;
  async function onScanSuccess(decodedText) {
    const code = String(decodedText || "").trim();
    if (!code) return;
    const now = Date.now();
    if (code === lastCode && now - lastCodeAt < 2500) return;
    lastCode = code;
    lastCodeAt = now;
    $("#scanHint").textContent = `Code ${code} – lade Produktdaten …`;
    try {
      if (html5QrCode) await html5QrCode.pause(true);
    } catch (_) {}
    await fetchOffProduct(code);
  }

  async function fetchOffProduct(code) {
    try {
      const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.status !== 1 || !data.product) {
        await stopBarcodeScan();
        toast("Produkt nicht in Open Food Facts");
        openPreview({
          source: "manual",
          name: `Unbekannt (${code})`,
          kcal: 0,
          protein: 0,
          carbs: 0,
          fat: 0,
          grams: 100,
        });
        return;
      }
      const p = data.product;
      const n = p.nutriments || {};
      const kcal =
        n["energy-kcal_100g"] ??
        n["energy-kcal"] ??
        (n["energy_100g"] != null ? n["energy_100g"] / 4.184 : null);
      const protein = n["proteins_100g"] ?? n["proteins"];
      const carbs = n["carbohydrates_100g"] ?? n["carbohydrates"];
      const fat = n["fat_100g"] ?? n["fat"];

      const name =
        pickLocale(p, "product_name") ||
        p.product_name ||
        p.generic_name ||
        `Produkt ${code}`;

      const missing =
        kcal == null || protein == null || carbs == null || fat == null;

      await stopBarcodeScan();

      if (missing) {
        toast("Nährwerte unvollständig – bitte ergänzen");
      }

      $("#sourceBadge").dataset.barcode = code;
      openPreview({
        source: "barcode",
        barcode: code,
        name,
        kcal: num(kcal),
        protein: num(protein),
        carbs: num(carbs),
        fat: num(fat),
        grams: 100,
      });
    } catch (err) {
      console.error(err);
      await stopBarcodeScan();
      toast("OFF-Abfrage fehlgeschlagen");
      openPreview({
        source: "manual",
        name: "",
        kcal: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
        grams: 100,
      });
    }
  }

  function pickLocale(p, key) {
    return (
      p[`${key}_de`] ||
      p[`${key}_en`] ||
      p[`${key}_fr`] ||
      p[key] ||
      null
    );
  }

  // —— OCR ——
  $("#btnOcrPhoto").addEventListener("click", () => {
    ocrFileInput.value = "";
    ocrFileInput.click();
  });

  ocrFileInput.addEventListener("change", async () => {
    const file = ocrFileInput.files && ocrFileInput.files[0];
    if (!file) return;
    if (typeof Tesseract === "undefined") {
      toast("Tesseract noch nicht geladen");
      return;
    }
    ocrAbort = false;
    ocrSheet.showModal();
    const img = $("#ocrPreviewImg");
    img.hidden = false;
    img.src = URL.createObjectURL(file);
    $("#ocrStatus").textContent = "Bild wird gelesen …";
    $("#ocrProgress").style.width = "0%";

    try {
      const result = await Tesseract.recognize(file, "deu+eng", {
        logger: (m) => {
          if (ocrAbort) return;
          if (m.status === "recognizing text" && m.progress != null) {
            const pct = Math.round(m.progress * 100);
            $("#ocrProgress").style.width = `${pct}%`;
            $("#ocrStatus").textContent = `Erkenne Text … ${pct}%`;
          } else if (m.status) {
            $("#ocrStatus").textContent = statusDe(m.status);
          }
        },
      });
      if (ocrAbort) return;
      const text = result?.data?.text || "";
      const parsed = parseNutritionText(text);
      ocrSheet.close();
      if (!parsed.foundAny) {
        toast("Kaum Nährwerte erkannt – bitte manuell ergänzen");
      } else {
        toast("OCR fertig – Werte prüfen");
      }
      openPreview({
        source: "ocr",
        name: parsed.name || "",
        kcal: parsed.kcal ?? 0,
        protein: parsed.protein ?? 0,
        carbs: parsed.carbs ?? 0,
        fat: parsed.fat ?? 0,
        grams: 100,
      });
    } catch (err) {
      console.error(err);
      if (!ocrAbort) {
        toast("OCR fehlgeschlagen");
        ocrSheet.close();
        openPreview({ source: "ocr", name: "", kcal: 0, protein: 0, carbs: 0, fat: 0, grams: 100 });
      }
    }
  });

  $("#ocrCancel").addEventListener("click", () => {
    ocrAbort = true;
    ocrSheet.close();
  });

  function statusDe(s) {
    const map = {
      loading_tesseract_core: "Lade OCR-Kern …",
      initializing_tesseract: "Initialisiere …",
      loading_language: "Lade Sprache …",
      initializing_api: "Starte Erkennung …",
      recognizing_text: "Erkenne Text …",
    };
    return map[s] || s.replace(/_/g, " ");
  }

  /**
   * Heuristic German/EU nutrition label parser.
   * Looks for Brennwert/Energie/kcal, Eiweiß/Protein, Kohlenhydrate, Fett per 100g.
   */
  function parseNutritionText(raw) {
    const text = String(raw || "")
      .replace(/\u00a0/g, " ")
      .replace(/[|]/g, " ")
      .replace(/\s+/g, " ");
    const lower = text.toLowerCase();

    const out = { kcal: null, protein: null, carbs: null, fat: null, name: "", foundAny: false };

    // Prefer per 100 g / 100ml section if present
    let scope = text;
    const per100 = text.match(/pro\s*100\s*(?:g|ml|gramm)[\s\S]{0,400}/i);
    if (per100) scope = per100[0];

    function findNear(labels, unitHints) {
      for (const lab of labels) {
        const re = new RegExp(
          lab +
            "[^\\d]{0,40}([\\d]+(?:[.,]\\d+)?)\\s*(?:" +
            unitHints +
            ")?",
          "i"
        );
        const m = scope.match(re) || text.match(re);
        if (m) return num(m[1]);
      }
      return null;
    }

    // Energy: prefer explicit kcal; convert kJ if needed
    let kcal = null;
    const kcalDirect = scope.match(/([\d]+(?:[.,]\d+)?)\s*kcal\b/i)
      || text.match(/([\d]+(?:[.,]\d+)?)\s*kcal\b/i);
    if (kcalDirect) {
      kcal = num(kcalDirect[1]);
    } else {
      const kj = scope.match(/([\d]+(?:[.,]\d+)?)\s*kJ\b/i)
        || text.match(/([\d]+(?:[.,]\d+)?)\s*kJ\b/i);
      if (kj) kcal = round1(num(kj[1]) / 4.184);
      else {
        // fallback: number after Brennwert/Energie without unit
        kcal = findNear(["brennwert", "energie", "energy", "kalorien"], "kcal|kalorien|kj");
      }
    }

    const protein = findNear(
      ["eiwei[sßz]", "protein", "proteine"],
      "g|gramm"
    );
    const carbs = findNear(
      ["kohlenhydrate", "kohlenhydrat", "carb(?:ohydrate)?s?"],
      "g|gramm"
    );
    const fat = findNear(["\\bfett\\b", "\\bfats?\\b", "lipide"], "g|gramm");

    out.kcal = kcal;
    out.protein = protein;
    out.carbs = carbs;
    out.fat = fat;
    out.foundAny = [kcal, protein, carbs, fat].some((v) => v != null && v > 0);

    // crude name: first non-empty line that isn't a nutrient header
    const lines = String(raw || "")
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines.slice(0, 5)) {
      if (/brennwert|energie|eiwei|protein|kohlenhydrat|fett|nährwert|pro 100/i.test(line))
        continue;
      if (line.length >= 3 && line.length <= 60) {
        out.name = line;
        break;
      }
    }

    return out;
  }

  // —— Init ——
  fillGoalsForm();
  renderHeute();
  showPanel("heute");
})();
