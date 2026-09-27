/* Mahlzeiten-Rechner v2 — salt, OCR harden, products/recipes, micros Phase A/B */
(() => {
  "use strict";

  const STORAGE_KEY = "mahlzeiten_rechner_v2";
  const STORAGE_KEY_V1 = "mahlzeiten_rechner_v1";
  const HISTORY_DAYS = 7;
  const SCHEMA_VERSION = 2;

  const DEFAULT_GOALS = { kcal: 2200, protein: 160, carbs: 200, fat: 70 };

  const PHASE_A = ["sugar", "satFat", "fiber", "salt"];
  const PHASE_B = [
    { key: "vitaminC", id: "nutVitC", label: "Vit. C", unit: "mg" },
    { key: "calcium", id: "nutCalcium", label: "Calcium", unit: "mg" },
    { key: "iron", id: "nutIron", label: "Eisen", unit: "mg" },
    { key: "magnesium", id: "nutMagnesium", label: "Magnesium", unit: "mg" },
    { key: "potassium", id: "nutPotassium", label: "Kalium", unit: "mg" },
  ];

  const TITLES = {
    heute: "Heute",
    add: "Hinzufügen",
    verlauf: "Verlauf",
    ziele: "Ziele",
  };

  /** @type {{ version: number, goals: typeof DEFAULT_GOALS, entries: Entry[], products: Product[], recipes: Recipe[] }} */
  let state = loadState();

  /**
   * @typedef {{
   *   kcal: number, protein: number, carbs: number, fat: number,
   *   sugar: number, satFat: number, fiber: number, salt: number,
   *   vitaminC?: number|null, calcium?: number|null, iron?: number|null,
   *   magnesium?: number|null, potassium?: number|null
   * }} Nutrients
   */

  /**
   * @typedef {{
   *   id: string, date: string, createdAt: string, name: string, grams: number,
   *   per100: Nutrients, totals: Nutrients, source: string,
   *   barcode?: string, productId?: string, recipeId?: string,
   *   saltConvertedFromSodium?: boolean
   * }} Entry
   */

  /**
   * @typedef {{
   *   id: string, name: string, barcode?: string, per100: Nutrients,
   *   saltConvertedFromSodium?: boolean, createdAt: string
   * }} Product
   */

  /**
   * @typedef {{
   *   id: string, name: string, portions: number,
   *   ingredients: { productId: string, name: string, grams: number, per100: Nutrients }[],
   *   createdAt: string
   * }} Recipe
   */

  let html5QrCode = null;
  let ocrAbort = false;
  let pendingSource = "manual";
  let pendingBarcode = undefined;
  let pendingSaltConverted = false;
  let pendingProductId = undefined;
  let pendingRecipeId = undefined;
  let editingRecipeId = null;
  /** @type {{ productId: string, name: string, grams: number, per100: Nutrients }[]} */
  let recipeDraftIngredients = [];

  // Crop state
  let cropImg = null;
  let cropRect = { x: 0.08, y: 0.08, w: 0.84, h: 0.84 }; // normalized
  let cropDrag = null;

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
  const cropSheet = $("#cropSheet");
  const productsSheet = $("#productsSheet");
  const recipesSheet = $("#recipesSheet");
  const recipeEditSheet = $("#recipeEditSheet");
  const ocrFileInput = $("#ocrFileInput");
  const cropCanvas = $("#cropCanvas");
  let cropCtx = null;
  function getCropCtx() {
    if (!cropCtx && cropCanvas) cropCtx = cropCanvas.getContext("2d");
    return cropCtx;
  }

  // —— Nutrients helpers ——
  function emptyNutrients() {
    return {
      kcal: 0, protein: 0, carbs: 0, fat: 0,
      sugar: 0, satFat: 0, fiber: 0, salt: 0,
      vitaminC: null, calcium: null, iron: null, magnesium: null, potassium: null,
    };
  }

  function normalizeNutrients(raw) {
    const n = emptyNutrients();
    if (!raw || typeof raw !== "object") return n;
    n.kcal = num(raw.kcal);
    n.protein = num(raw.protein);
    n.carbs = num(raw.carbs);
    n.fat = num(raw.fat);
    n.sugar = num(raw.sugar);
    n.satFat = num(raw.satFat);
    n.fiber = num(raw.fiber);
    n.salt = num(raw.salt);
    for (const { key } of PHASE_B) {
      if (raw[key] != null && raw[key] !== "" && Number.isFinite(Number(raw[key]))) {
        n[key] = num(raw[key]);
      } else {
        n[key] = null;
      }
    }
    return n;
  }

  function scaleMacros(per100, grams) {
    const f = grams / 100;
    const out = {
      kcal: round1(per100.kcal * f),
      protein: round1(per100.protein * f),
      carbs: round1(per100.carbs * f),
      fat: round1(per100.fat * f),
      sugar: round1((per100.sugar || 0) * f),
      satFat: round1((per100.satFat || 0) * f),
      fiber: round1((per100.fiber || 0) * f),
      salt: round2((per100.salt || 0) * f),
    };
    for (const { key } of PHASE_B) {
      if (per100[key] != null && Number.isFinite(per100[key])) {
        out[key] = round1(per100[key] * f);
      } else {
        out[key] = null;
      }
    }
    return out;
  }

  function addNutrients(a, b) {
    const out = {
      kcal: (a.kcal || 0) + (b.kcal || 0),
      protein: (a.protein || 0) + (b.protein || 0),
      carbs: (a.carbs || 0) + (b.carbs || 0),
      fat: (a.fat || 0) + (b.fat || 0),
      sugar: (a.sugar || 0) + (b.sugar || 0),
      satFat: (a.satFat || 0) + (b.satFat || 0),
      fiber: (a.fiber || 0) + (b.fiber || 0),
      salt: (a.salt || 0) + (b.salt || 0),
    };
    for (const { key } of PHASE_B) {
      const av = a[key];
      const bv = b[key];
      if (av != null || bv != null) {
        out[key] = (av || 0) + (bv || 0);
      } else {
        out[key] = null;
      }
    }
    return out;
  }

  // —— Storage ——
  function migrateEntry(e) {
    const per100 = normalizeNutrients(e.per100 || {
      kcal: e.totals?.kcal, protein: e.totals?.protein, carbs: e.totals?.carbs, fat: e.totals?.fat,
    });
    // If old entry only had totals without per100 structure, rebuild
    const grams = num(e.grams, 100);
    let totals = e.totals ? normalizeNutrients({
      ...e.totals,
      sugar: e.totals.sugar ?? scaleMacros(per100, grams).sugar,
      satFat: e.totals.satFat ?? scaleMacros(per100, grams).satFat,
      fiber: e.totals.fiber ?? scaleMacros(per100, grams).fiber,
      salt: e.totals.salt ?? scaleMacros(per100, grams).salt,
    }) : scaleMacros(per100, grams);
    // Ensure Phase A present on totals
    totals = normalizeNutrients(totals);
    return {
      ...e,
      per100,
      totals,
      grams,
    };
  }

  function loadState() {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      let fromV1 = false;
      if (!raw) {
        const v1 = localStorage.getItem(STORAGE_KEY_V1);
        if (v1) {
          raw = v1;
          fromV1 = true;
        }
      }
      if (!raw) {
        return { version: SCHEMA_VERSION, goals: { ...DEFAULT_GOALS }, entries: [], products: [], recipes: [] };
      }
      const parsed = JSON.parse(raw);
      const entries = (Array.isArray(parsed.entries) ? parsed.entries : []).map(migrateEntry);
      const stateObj = {
        version: SCHEMA_VERSION,
        goals: { ...DEFAULT_GOALS, ...(parsed.goals || {}) },
        entries,
        products: Array.isArray(parsed.products)
          ? parsed.products.map((p) => ({
              ...p,
              per100: normalizeNutrients(p.per100),
            }))
          : [],
        recipes: Array.isArray(parsed.recipes) ? parsed.recipes : [],
      };
      // Drop unknown goal fields we don't want (salt etc.)
      stateObj.goals = {
        kcal: num(stateObj.goals.kcal, DEFAULT_GOALS.kcal),
        protein: num(stateObj.goals.protein, DEFAULT_GOALS.protein),
        carbs: num(stateObj.goals.carbs, DEFAULT_GOALS.carbs),
        fat: num(stateObj.goals.fat, DEFAULT_GOALS.fat),
      };
      if (fromV1) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stateObj));
      }
      return stateObj;
    } catch {
      return { version: SCHEMA_VERSION, goals: { ...DEFAULT_GOALS }, entries: [], products: [], recipes: [] };
    }
  }

  function saveState() {
    const cutoff = dayOffset(-HISTORY_DAYS + 1);
    state.entries = state.entries.filter((e) => e.date >= cutoff);
    state.version = SCHEMA_VERSION;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: state.version,
        goals: state.goals,
        entries: state.entries,
        products: state.products,
        recipes: state.recipes,
      })
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

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function fmt(n, digits = 0) {
    const x = Number(n) || 0;
    return x.toLocaleString("de-DE", {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits > 0 && x % 1 !== 0 ? Math.min(digits, 1) : 0,
    });
  }

  function fmtOpt(n, digits, unit) {
    if (n == null || !Number.isFinite(n)) return "—";
    return `${fmt(n, digits)} ${unit}`;
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove("show"), 2800);
  }


  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-lazy-src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === "1") return resolve();
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Script failed: " + src)), { once: true });
        return;
      }
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.dataset.lazySrc = src;
      s.onload = () => {
        s.dataset.loaded = "1";
        resolve();
      };
      s.onerror = () => reject(new Error("Script failed: " + src));
      document.head.appendChild(s);
    });
  }

  async function ensureHtml5Qrcode() {
    if (typeof Html5Qrcode !== "undefined") return;
    toast("Lade Scanner …");
    await loadScript("https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js");
    if (typeof Html5Qrcode === "undefined") {
      await loadScript("https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js");
    }
    if (typeof Html5Qrcode === "undefined") throw new Error("Scanner-Bibliothek nicht geladen");
  }

  async function ensureTesseract() {
    if (typeof Tesseract !== "undefined") return;
    toast("Lade OCR …");
    await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js");
    if (typeof Tesseract === "undefined") {
      await loadScript("https://unpkg.com/tesseract.js@5/dist/tesseract.min.js");
    }
    if (typeof Tesseract === "undefined") throw new Error("OCR-Bibliothek nicht geladen");
  }

  function optionalInput(id) {
    const el = $(`#${id}`);
    if (!el || el.value === "" || el.value == null) return null;
    return num(el.value);
  }

  function setOptionalInput(id, v) {
    $(`#${id}`).value = v != null && Number.isFinite(v) ? String(v) : "";
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
      (acc, e) => addNutrients(acc, normalizeNutrients(e.totals)),
      emptyNutrients()
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

    $("#sumSugar").textContent = `${fmt(sum.sugar, 1)} g`;
    $("#sumSatFat").textContent = `${fmt(sum.satFat, 1)} g`;
    $("#sumFiber").textContent = `${fmt(sum.fiber, 1)} g`;
    $("#sumSalt").textContent = `${fmt(sum.salt, 2)} g`;

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
    const t = normalizeNutrients(e.totals);
    const microBits = [
      t.sugar ? `Z ${fmt(t.sugar, 1)}` : null,
      t.satFat ? `GS ${fmt(t.satFat, 1)}` : null,
      t.fiber ? `B ${fmt(t.fiber, 1)}` : null,
      t.salt ? `Salz ${fmt(t.salt, 2)}` : null,
    ].filter(Boolean);
    const phaseB = PHASE_B.map(({ key, label, unit }) => {
      if (t[key] == null) return null;
      return `${label} ${fmt(t[key], key === "iron" || key === "vitaminC" ? 1 : 0)}${unit}`;
    }).filter(Boolean);
    const extra = [...microBits, ...phaseB].join(" · ");
    return `<li class="entry-item" data-id="${e.id}">
      <div>
        <div class="name">${escapeHtml(e.name)}</div>
        <div class="meta">${fmt(e.grams, 0)} g · ${sourceLabel(e.source)}${e.saltConvertedFromSodium ? " · Salz≈Na×2.5" : ""}</div>
        ${extra ? `<div class="meta micro-meta">${escapeHtml(extra)}</div>` : ""}
      </div>
      <div class="macros">${fmt(t.kcal, 0)} kcal<br>${fmt(t.protein, 1)} P · ${fmt(t.carbs, 1)} KH · ${fmt(t.fat, 1)} F</div>
      <div class="entry-actions">
        <button type="button" class="btn btn-sm btn-danger" data-del="${e.id}">Löschen</button>
      </div>
    </li>`;
  }

  function sourceLabel(s) {
    if (s === "barcode") return "Barcode";
    if (s === "ocr") return "OCR";
    if (s === "product") return "Produkt";
    if (s === "recipe") return "Rezept";
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
          <h3>${label} · ${fmt(sum.kcal, 0)} kcal · Salz ${fmt(sum.salt, 2)} g</h3>
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
  function readPreviewNutrients() {
    const n = {
      kcal: num($("#nutKcal").value),
      protein: num($("#nutProtein").value),
      carbs: num($("#nutCarbs").value),
      fat: num($("#nutFat").value),
      sugar: num($("#nutSugar").value),
      satFat: num($("#nutSatFat").value),
      fiber: num($("#nutFiber").value),
      salt: num($("#nutSalt").value),
    };
    for (const { key, id } of PHASE_B) {
      n[key] = optionalInput(id);
    }
    return normalizeNutrients(n);
  }

  function openPreview(data) {
    pendingSource = data.source || "manual";
    pendingBarcode = data.barcode || undefined;
    pendingSaltConverted = !!data.saltConvertedFromSodium;
    pendingProductId = data.productId || undefined;
    pendingRecipeId = data.recipeId || undefined;

    $("#sourceBadge").textContent =
      pendingSource === "barcode"
        ? `Barcode${pendingBarcode ? " · " + pendingBarcode : ""} · Open Food Facts`
        : pendingSource === "ocr"
          ? "OCR · bitte korrigieren"
          : pendingSource === "product"
            ? "Gespeichertes Produkt"
            : pendingSource === "recipe"
              ? "Rezept · 1 Portion"
              : "Manuell";

    const failNote = $("#ocrFailNote");
    if (data.ocrFailed) {
      failNote.hidden = false;
    } else {
      failNote.hidden = true;
    }

    $("#prodName").value = data.name || "";
    $("#nutKcal").value = data.kcal != null ? round1(num(data.kcal)) : "";
    $("#nutProtein").value = data.protein != null ? round1(num(data.protein)) : "";
    $("#nutCarbs").value = data.carbs != null ? round1(num(data.carbs)) : "";
    $("#nutFat").value = data.fat != null ? round1(num(data.fat)) : "";
    $("#nutSugar").value = data.sugar != null ? round1(num(data.sugar)) : "";
    $("#nutSatFat").value = data.satFat != null ? round1(num(data.satFat)) : "";
    $("#nutFiber").value = data.fiber != null ? round1(num(data.fiber)) : "";
    $("#nutSalt").value = data.salt != null ? round2(num(data.salt)) : "";

    const saltHint = $("#saltHint");
    saltHint.hidden = !pendingSaltConverted;

    setOptionalInput("nutVitC", data.vitaminC);
    setOptionalInput("nutCalcium", data.calcium);
    setOptionalInput("nutIron", data.iron);
    setOptionalInput("nutMagnesium", data.magnesium);
    setOptionalInput("nutPotassium", data.potassium);

    // Open Phase B if any present
    const hasB = PHASE_B.some(({ key }) => data[key] != null);
    $("#phaseBDetails").open = hasB;

    $("#gramsEaten").value = data.grams || (pendingSource === "recipe" ? data.grams || 100 : 100);
    $("#saveAsProduct").checked = false;
    $("#saveProductRow").hidden = pendingSource === "recipe" || pendingSource === "product";

    updateScaledPreview();
    if (previewSheet.showModal && !previewSheet.open) previewSheet.showModal();
  }

  function updateScaledPreview() {
    const per100 = readPreviewNutrients();
    const grams = num($("#gramsEaten").value, 100);
    const t = scaleMacros(per100, grams);
    let text = `${fmt(t.kcal, 0)} kcal · ${fmt(t.protein, 1)} g P · ${fmt(t.carbs, 1)} g KH · ${fmt(t.fat, 1)} g F`;
    text += ` · Zucker ${fmt(t.sugar, 1)} · GS ${fmt(t.satFat, 1)} · Ballast ${fmt(t.fiber, 1)} · Salz ${fmt(t.salt, 2)} g`;
    const bBits = PHASE_B.map(({ key, label, unit }) => {
      if (t[key] == null) return null;
      return `${label} ${fmt(t[key], 1)}${unit}`;
    }).filter(Boolean);
    if (bBits.length) text += ` · ${bBits.join(" · ")}`;
    $("#scaledText").textContent = text;
  }

  ["nutKcal", "nutProtein", "nutCarbs", "nutFat", "nutSugar", "nutSatFat", "nutFiber", "nutSalt",
    "nutVitC", "nutCalcium", "nutIron", "nutMagnesium", "nutPotassium", "gramsEaten"].forEach((id) => {
    const el = $(`#${id}`);
    if (el) el.addEventListener("input", () => {
      if (id === "nutSalt") {
        pendingSaltConverted = false;
        $("#saltHint").hidden = true;
      }
      updateScaledPreview();
    });
  });

  $("#previewCancel").addEventListener("click", () => previewSheet.close());

  $("#previewForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#prodName").value.trim() || "Unbenannt";
    const per100 = readPreviewNutrients();
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
      barcode: pendingBarcode,
      productId: pendingProductId,
      recipeId: pendingRecipeId,
      saltConvertedFromSodium: pendingSaltConverted || undefined,
    };
    state.entries.push(entry);

    if ($("#saveAsProduct").checked && pendingSource !== "recipe") {
      const prod = {
        id: uid(),
        name,
        barcode: pendingBarcode,
        per100,
        saltConvertedFromSodium: pendingSaltConverted || undefined,
        createdAt: new Date().toISOString(),
      };
      // Replace existing with same barcode if any
      if (pendingBarcode) {
        state.products = state.products.filter((p) => p.barcode !== pendingBarcode);
      }
      state.products.unshift(prod);
      toast("Eintrag + Produkt gespeichert");
    } else {
      toast("Zur Tages-Summe hinzugefügt");
    }

    saveState();
    previewSheet.close();
    showPanel("heute");
  });

  // —— Manual ——
  $("#btnManual").addEventListener("click", () => {
    openPreview({
      source: "manual",
      name: "",
      kcal: 0, protein: 0, carbs: 0, fat: 0,
      sugar: 0, satFat: 0, fiber: 0, salt: 0,
      grams: 100,
    });
  });

  // —— Barcode / OFF ——
  $("#btnScanBarcode").addEventListener("click", startBarcodeScan);
  $("#scanCancel").addEventListener("click", stopBarcodeScan);

  async function startBarcodeScan() {
    try {
      await ensureHtml5Qrcode();
    } catch (err) {
      console.error(err);
      toast("Scanner konnte nicht geladen werden (Netzwerk/CDN)");
      return;
    }
    if (!scanSheet.showModal) {
      toast("Dialog nicht unterstützt – Browser aktualisieren");
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

  function extractOffNutrients(n) {
    const kcal =
      n["energy-kcal_100g"] ??
      n["energy-kcal"] ??
      (n["energy_100g"] != null ? n["energy_100g"] / 4.184 : null);
    const protein = n["proteins_100g"] ?? n["proteins"];
    const carbs = n["carbohydrates_100g"] ?? n["carbohydrates"];
    const fat = n["fat_100g"] ?? n["fat"];
    const sugar = n["sugars_100g"] ?? n["sugars"];
    const satFat = n["saturated-fat_100g"] ?? n["saturated-fat"];
    const fiber = n["fiber_100g"] ?? n["fiber"];

    let salt = n["salt_100g"] ?? n["salt"];
    let saltConvertedFromSodium = false;
    if (salt == null) {
      const sodium = n["sodium_100g"] ?? n["sodium"];
      if (sodium != null) {
        salt = num(sodium) * 2.5;
        saltConvertedFromSodium = true;
      }
    }

    const vitaminC = n["vitamin-c_100g"] ?? n["vitamin-c"] ?? null;
    const calcium = n["calcium_100g"] ?? n["calcium"] ?? null;
    const iron = n["iron_100g"] ?? n["iron"] ?? null;
    const magnesium = n["magnesium_100g"] ?? n["magnesium"] ?? null;
    const potassium = n["potassium_100g"] ?? n["potassium"] ?? null;

    return {
      kcal: kcal != null ? num(kcal) : null,
      protein: protein != null ? num(protein) : null,
      carbs: carbs != null ? num(carbs) : null,
      fat: fat != null ? num(fat) : null,
      sugar: sugar != null ? num(sugar) : null,
      satFat: satFat != null ? num(satFat) : null,
      fiber: fiber != null ? num(fiber) : null,
      salt: salt != null ? num(salt) : null,
      saltConvertedFromSodium,
      vitaminC: vitaminC != null ? num(vitaminC) : null,
      calcium: calcium != null ? num(calcium) : null,
      iron: iron != null ? num(iron) : null,
      magnesium: magnesium != null ? num(magnesium) : null,
      potassium: potassium != null ? num(potassium) : null,
    };
  }

  async function fetchOffProduct(code) {
    try {
      const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.status !== 1 || !data.product) {
        await stopBarcodeScan();
        toast("Produkt nicht in Open Food Facts");
        openPreview({
          source: "manual",
          name: `Unbekannt (${code})`,
          barcode: code,
          kcal: 0, protein: 0, carbs: 0, fat: 0,
          sugar: 0, satFat: 0, fiber: 0, salt: 0,
          grams: 100,
        });
        return;
      }
      const p = data.product;
      const nuts = extractOffNutrients(p.nutriments || {});
      const name =
        pickLocale(p, "product_name") ||
        p.product_name ||
        p.generic_name ||
        `Produkt ${code}`;

      const missing =
        nuts.kcal == null || nuts.protein == null || nuts.carbs == null || nuts.fat == null;

      await stopBarcodeScan();
      if (missing) toast("Nährwerte unvollständig – bitte ergänzen");

      openPreview({
        source: "barcode",
        barcode: code,
        name,
        kcal: nuts.kcal ?? 0,
        protein: nuts.protein ?? 0,
        carbs: nuts.carbs ?? 0,
        fat: nuts.fat ?? 0,
        sugar: nuts.sugar ?? 0,
        satFat: nuts.satFat ?? 0,
        fiber: nuts.fiber ?? 0,
        salt: nuts.salt ?? 0,
        saltConvertedFromSodium: nuts.saltConvertedFromSodium,
        vitaminC: nuts.vitaminC,
        calcium: nuts.calcium,
        iron: nuts.iron,
        magnesium: nuts.magnesium,
        potassium: nuts.potassium,
        grams: 100,
      });
    } catch (err) {
      console.error(err);
      await stopBarcodeScan();
      toast("OFF-Abfrage fehlgeschlagen");
      openPreview({
        source: "manual",
        name: "",
        kcal: 0, protein: 0, carbs: 0, fat: 0,
        sugar: 0, satFat: 0, fiber: 0, salt: 0,
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

  // —— OCR: crop + preprocess ——
  $("#btnOcrPhoto").addEventListener("click", () => {
    ocrFileInput.value = "";
    ocrFileInput.click();
  });

  ocrFileInput.addEventListener("change", async () => {
    const file = ocrFileInput.files && ocrFileInput.files[0];
    if (!file) return;
    try {
      const url = URL.createObjectURL(file);
      cropImg = await loadImage(url);
      URL.revokeObjectURL(url);
      cropRect = { x: 0.08, y: 0.08, w: 0.84, h: 0.84 };
      drawCrop();
      cropSheet.showModal();
    } catch (err) {
      console.error(err);
      toast("Bild konnte nicht geladen werden");
    }
  });

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function drawCrop() {
    if (!cropImg) return;
    const maxW = Math.min(420, (cropSheet.clientWidth || 360) - 40);
    const scale = Math.min(1, maxW / cropImg.width);
    const w = Math.round(cropImg.width * scale);
    const h = Math.round(cropImg.height * scale);
    cropCanvas.width = w;
    cropCanvas.height = h;
    cropCanvas.style.width = `${w}px`;
    cropCanvas.style.height = `${h}px`;
    getCropCtx().drawImage(cropImg, 0, 0, w, h);
    // dim outside
    const rx = cropRect.x * w;
    const ry = cropRect.y * h;
    const rw = cropRect.w * w;
    const rh = cropRect.h * h;
    getCropCtx().fillStyle = "rgba(0,0,0,0.55)";
    getCropCtx().fillRect(0, 0, w, h);
    getCropCtx().clearRect(rx, ry, rw, rh);
    getCropCtx().drawImage(cropImg, cropRect.x * cropImg.width, cropRect.y * cropImg.height,
      cropRect.w * cropImg.width, cropRect.h * cropImg.height,
      rx, ry, rw, rh);
    getCropCtx().strokeStyle = "#ff7a59";
    getCropCtx().lineWidth = 2;
    getCropCtx().strokeRect(rx, ry, rw, rh);
    // handles
    const hs = 14;
    getCropCtx().fillStyle = "#ff7a59";
    [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]].forEach(([hx, hy]) => {
      getCropCtx().fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
    });
  }

  function canvasPos(e) {
    const rect = cropCanvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return {
      x: (t.clientX - rect.left) / rect.width,
      y: (t.clientY - rect.top) / rect.height,
    };
  }

  function hitHandle(p) {
    const corners = [
      { name: "nw", x: cropRect.x, y: cropRect.y },
      { name: "ne", x: cropRect.x + cropRect.w, y: cropRect.y },
      { name: "sw", x: cropRect.x, y: cropRect.y + cropRect.h },
      { name: "se", x: cropRect.x + cropRect.w, y: cropRect.y + cropRect.h },
    ];
    const thr = 0.06;
    for (const c of corners) {
      if (Math.abs(p.x - c.x) < thr && Math.abs(p.y - c.y) < thr) return c.name;
    }
    if (
      p.x >= cropRect.x && p.x <= cropRect.x + cropRect.w &&
      p.y >= cropRect.y && p.y <= cropRect.y + cropRect.h
    ) return "move";
    return null;
  }

  function onCropStart(e) {
    e.preventDefault();
    const p = canvasPos(e);
    const h = hitHandle(p);
    if (!h) return;
    cropDrag = { handle: h, start: p, orig: { ...cropRect } };
  }

  function onCropMove(e) {
    if (!cropDrag) return;
    e.preventDefault();
    const p = canvasPos(e);
    const dx = p.x - cropDrag.start.x;
    const dy = p.y - cropDrag.start.y;
    const o = cropDrag.orig;
    let r = { ...o };
    if (cropDrag.handle === "move") {
      r.x = Math.min(Math.max(0, o.x + dx), 1 - o.w);
      r.y = Math.min(Math.max(0, o.y + dy), 1 - o.h);
    } else {
      let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
      if (cropDrag.handle.includes("n")) y1 = o.y + dy;
      if (cropDrag.handle.includes("s")) y2 = o.y + o.h + dy;
      if (cropDrag.handle.includes("w")) x1 = o.x + dx;
      if (cropDrag.handle.includes("e")) x2 = o.x + o.w + dx;
      x1 = Math.min(Math.max(0, x1), 0.98);
      y1 = Math.min(Math.max(0, y1), 0.98);
      x2 = Math.min(Math.max(0.02, x2), 1);
      y2 = Math.min(Math.max(0.02, y2), 1);
      if (x2 - x1 < 0.08) { if (cropDrag.handle.includes("w")) x1 = x2 - 0.08; else x2 = x1 + 0.08; }
      if (y2 - y1 < 0.08) { if (cropDrag.handle.includes("n")) y1 = y2 - 0.08; else y2 = y1 + 0.08; }
      r = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    cropRect = r;
    drawCrop();
  }

  function onCropEnd() {
    cropDrag = null;
  }

  cropCanvas.addEventListener("mousedown", onCropStart);
  cropCanvas.addEventListener("mousemove", onCropMove);
  window.addEventListener("mouseup", onCropEnd);
  cropCanvas.addEventListener("touchstart", onCropStart, { passive: false });
  cropCanvas.addEventListener("touchmove", onCropMove, { passive: false });
  cropCanvas.addEventListener("touchend", onCropEnd);

  $("#cropCancel").addEventListener("click", () => {
    cropSheet.close();
    cropImg = null;
  });

  $("#cropRun").addEventListener("click", async () => {
    if (!cropImg) return;
    try {
      await ensureTesseract();
    } catch (err) {
      console.error(err);
      toast("OCR konnte nicht geladen werden (Netzwerk/CDN)");
      return;
    }
    cropSheet.close();
    const processed = preprocessCrop(cropImg, cropRect);
    await runOcrOnBlob(processed);
  });

  function preprocessCrop(img, rect) {
    const sx = Math.round(rect.x * img.width);
    const sy = Math.round(rect.y * img.height);
    const sw = Math.max(32, Math.round(rect.w * img.width));
    const sh = Math.max(32, Math.round(rect.h * img.height));
    // Upscale small crops for OCR
    const scale = Math.max(1, Math.min(2.5, 1200 / Math.max(sw, sh)));
    const dw = Math.round(sw * scale);
    const dh = Math.round(sh * scale);
    const c = document.createElement("canvas");
    c.width = dw;
    c.height = dh;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
    const imageData = ctx.getImageData(0, 0, dw, dh);
    const d = imageData.data;
    // grayscale + contrast stretch
    let min = 255, max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = g;
      if (g < min) min = g;
      if (g > max) max = g;
    }
    const range = Math.max(1, max - min);
    for (let i = 0; i < d.length; i += 4) {
      let g = ((d[i] - min) / range) * 255;
      // mild contrast boost around mid
      g = (g - 128) * 1.35 + 128;
      // adaptive-ish threshold soft
      g = g > 165 ? 255 : g < 90 ? 0 : g;
      d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, g));
    }
    ctx.putImageData(imageData, 0, 0);
    return c;
  }

  async function runOcrOnBlob(canvasOrFile) {
    ocrAbort = false;
    ocrSheet.showModal();
    const img = $("#ocrPreviewImg");
    img.hidden = false;
    if (canvasOrFile instanceof HTMLCanvasElement) {
      img.src = canvasOrFile.toDataURL("image/png");
    } else {
      img.src = URL.createObjectURL(canvasOrFile);
    }
    $("#ocrStatus").textContent = "Vorverarbeitung fertig – OCR startet …";
    $("#ocrProgress").style.width = "0%";

    try {
      const result = await Tesseract.recognize(canvasOrFile, "deu+eng", {
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
      const conf = typeof result?.data?.confidence === "number" ? result.data.confidence : 0;
      const parsed = parseNutritionText(text);
      ocrSheet.close();

      const weak =
        !parsed.foundAny ||
        conf < 35 ||
        [parsed.kcal, parsed.protein, parsed.carbs, parsed.fat].filter((v) => v != null).length === 0;

      if (weak) {
        toast("Nichts erkannt — bitte manuell eingeben");
        openPreview({
          source: "ocr",
          ocrFailed: true,
          name: parsed.name || "",
          kcal: null, protein: null, carbs: null, fat: null,
          sugar: null, satFat: null, fiber: null, salt: null,
          grams: 100,
        });
        // Clear required fields visually to empty for manual
        $("#nutKcal").value = "";
        $("#nutProtein").value = "";
        $("#nutCarbs").value = "";
        $("#nutFat").value = "";
        $("#nutSugar").value = "";
        $("#nutSatFat").value = "";
        $("#nutFiber").value = "";
        $("#nutSalt").value = "";
        updateScaledPreview();
      } else {
        toast("OCR fertig – Werte prüfen");
        openPreview({
          source: "ocr",
          name: parsed.name || "",
          kcal: parsed.kcal ?? 0,
          protein: parsed.protein ?? 0,
          carbs: parsed.carbs ?? 0,
          fat: parsed.fat ?? 0,
          sugar: parsed.sugar ?? 0,
          satFat: parsed.satFat ?? 0,
          fiber: parsed.fiber ?? 0,
          salt: parsed.salt ?? 0,
          grams: 100,
        });
      }
    } catch (err) {
      console.error(err);
      if (!ocrAbort) {
        toast("OCR fehlgeschlagen");
        ocrSheet.close();
        openPreview({
          source: "ocr",
          ocrFailed: true,
          name: "",
          kcal: null, protein: null, carbs: null, fat: null,
          sugar: null, satFat: null, fiber: null, salt: null,
          grams: 100,
        });
        $("#nutKcal").value = "";
        $("#nutProtein").value = "";
        $("#nutCarbs").value = "";
        $("#nutFat").value = "";
        updateScaledPreview();
      }
    } finally {
      cropImg = null;
    }
  }

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
   * Labels: Brennwert/Energie, Fett, davon gesättigte, Kohlenhydrate, Zucker,
   * Eiweiß/Protein, Ballaststoffe, Salz. Units g/mg/kcal/kJ.
   */
  function parseNutritionText(raw) {
    const cleaned = String(raw || "")
      .replace(/\u00a0/g, " ")
      .replace(/[|]/g, " ")
      .replace(/[–—]/g, "-");
    const text = cleaned.replace(/\s+/g, " ");

    const out = {
      kcal: null, protein: null, carbs: null, fat: null,
      sugar: null, satFat: null, fiber: null, salt: null,
      name: "", foundAny: false,
    };

    let scope = text;
    const per100 = text.match(/pro\s*100\s*(?:g|ml|gramm)[\s\S]{0,600}/i);
    if (per100) scope = per100[0];

    function findNear(labels, unitHints) {
      for (const lab of labels) {
        const re = new RegExp(
          lab +
            "[^\\d]{0,48}([\\d]+(?:[.,]\\d+)?)\\s*(?:" +
            unitHints +
            ")?",
          "i"
        );
        const m = scope.match(re) || text.match(re);
        if (m) return num(m[1]);
      }
      return null;
    }

    // Energy
    let kcal = null;
    const kcalDirect = scope.match(/([\d]+(?:[.,]\d+)?)\s*kcal\b/i)
      || text.match(/([\d]+(?:[.,]\d+)?)\s*kcal\b/i);
    if (kcalDirect) {
      kcal = num(kcalDirect[1]);
    } else {
      const kjPair = scope.match(/([\d]+(?:[.,]\d+)?)\s*kJ\s*\/\s*([\d]+(?:[.,]\d+)?)\s*kcal/i)
        || text.match(/([\d]+(?:[.,]\d+)?)\s*kJ\s*\/\s*([\d]+(?:[.,]\d+)?)\s*kcal/i);
      if (kjPair) {
        kcal = num(kjPair[2]);
      } else {
        const kj = scope.match(/([\d]+(?:[.,]\d+)?)\s*kJ\b/i)
          || text.match(/([\d]+(?:[.,]\d+)?)\s*kJ\b/i);
        if (kj) kcal = round1(num(kj[1]) / 4.184);
        else {
          kcal = findNear(["brennwert", "energie", "energy", "kalorien"], "kcal|kalorien|kj");
        }
      }
    }

    // Fat before "davon gesättigte" to avoid capturing sat as fat wrongly —
    // look for Fett not preceded by gesättigt context on same match
    const fat = findNear(["\\bfett\\b(?!\\s*säure)", "\\bfats?\\b", "lipide"], "g|gramm|mg");
    const satFat = findNear([
      "davon\\s+gesättigt(?:e)?(?:\\s+fettsäuren)?",
      "gesättigte\\s+fettsäuren",
      "gesaettigte\\s+fettsaeuren",
      "saturated\\s+fat",
    ], "g|gramm|mg");

    const carbs = findNear(
      ["kohlenhydrate", "kohlenhydrat", "carb(?:ohydrate)?s?"],
      "g|gramm|mg"
    );
    // Zucker: avoid matching "Zuckeralkohole" as primary — still ok if number follows
    const sugar = findNear([
      "davon\\s+zucker",
      "\\bzucker\\b",
      "sugars?",
    ], "g|gramm|mg");

    const protein = findNear(
      ["eiwei[sßz]", "protein", "proteine"],
      "g|gramm|mg"
    );
    const fiber = findNear(
      ["ballaststoffe", "ballaststoff", "fiber", "fibre"],
      "g|gramm|mg"
    );
    let salt = findNear(["\\bsalz\\b", "\\bsalt\\b"], "g|gramm|mg");
    if (salt == null) {
      const sodium = findNear(["\\bnatrium\\b", "\\bsodium\\b"], "g|gramm|mg");
      if (sodium != null) {
        // if sodium in mg, convert; heuristic: > 5 likely mg on label for sodium
        const naG = sodium > 5 ? sodium / 1000 : sodium;
        salt = round2(naG * 2.5);
      }
    } else if (salt > 20) {
      // likely mg misread as g — uncommon for salt_100g > 20g; leave as-is but clamp sanity later
    }

    // Convert mg misreads for macros (typical per 100g macros are in g)
    function asGrams(v) {
      if (v == null) return null;
      // if absurdly high for a macro per 100g, maybe OCR glued numbers — leave
      return v;
    }

    out.kcal = kcal;
    out.protein = asGrams(protein);
    out.carbs = asGrams(carbs);
    out.fat = asGrams(fat);
    out.sugar = asGrams(sugar);
    out.satFat = asGrams(satFat);
    out.fiber = asGrams(fiber);
    out.salt = salt != null ? round2(salt) : null;
    out.foundAny = [kcal, protein, carbs, fat, sugar, satFat, fiber, salt].some(
      (v) => v != null && v > 0
    );

    const lines = String(raw || "")
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines.slice(0, 6)) {
      if (/brennwert|energie|eiwei|protein|kohlenhydrat|fett|nährwert|pro 100|zucker|salz|ballast|gesättigt/i.test(line))
        continue;
      if (line.length >= 3 && line.length <= 60) {
        out.name = line;
        break;
      }
    }

    return out;
  }

  // —— Products library ——
  $("#btnPickProduct").addEventListener("click", () => {
    renderProductsList();
    productsSheet.showModal();
  });
  $("#productsClose").addEventListener("click", () => productsSheet.close());

  function renderProductsList() {
    const empty = $("#productsEmpty");
    const ul = $("#productsList");
    if (!state.products.length) {
      empty.hidden = false;
      ul.innerHTML = "";
      return;
    }
    empty.hidden = true;
    ul.innerHTML = state.products
      .map((p) => {
        const n = normalizeNutrients(p.per100);
        return `<li class="lib-item">
          <button type="button" class="lib-main" data-use-product="${p.id}">
            <strong>${escapeHtml(p.name)}</strong>
            <span>${fmt(n.kcal, 0)} kcal / 100 g · P ${fmt(n.protein, 1)} · Salz ${fmt(n.salt, 2)} g${p.barcode ? " · " + escapeHtml(p.barcode) : ""}</span>
          </button>
          <button type="button" class="btn btn-sm btn-danger" data-del-product="${p.id}">Löschen</button>
        </li>`;
      })
      .join("");

    ul.querySelectorAll("[data-use-product]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-use-product");
        const p = state.products.find((x) => x.id === id);
        if (!p) return;
        productsSheet.close();
        const n = normalizeNutrients(p.per100);
        openPreview({
          source: "product",
          productId: p.id,
          barcode: p.barcode,
          name: p.name,
          ...n,
          saltConvertedFromSodium: p.saltConvertedFromSodium,
          grams: 100,
        });
      });
    });
    ul.querySelectorAll("[data-del-product]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-del-product");
        state.products = state.products.filter((p) => p.id !== id);
        saveState();
        toast("Produkt gelöscht");
        renderProductsList();
      });
    });
  }

  // —— Recipes ——
  $("#btnRecipes").addEventListener("click", () => {
    renderRecipesList();
    recipesSheet.showModal();
  });
  $("#recipesClose").addEventListener("click", () => recipesSheet.close());
  $("#btnNewRecipe").addEventListener("click", () => openRecipeEditor(null));
  $("#recipeEditCancel").addEventListener("click", () => recipeEditSheet.close());

  function recipeTotals(recipe) {
    const portions = Math.max(1, num(recipe.portions, 1));
    let sum = emptyNutrients();
    (recipe.ingredients || []).forEach((ing) => {
      const scaled = scaleMacros(normalizeNutrients(ing.per100), num(ing.grams, 0));
      sum = addNutrients(sum, scaled);
    });
    // per portion
    const f = 1 / portions;
    const per = {
      kcal: round1(sum.kcal * f),
      protein: round1(sum.protein * f),
      carbs: round1(sum.carbs * f),
      fat: round1(sum.fat * f),
      sugar: round1(sum.sugar * f),
      satFat: round1(sum.satFat * f),
      fiber: round1(sum.fiber * f),
      salt: round2(sum.salt * f),
    };
    for (const { key } of PHASE_B) {
      if (sum[key] != null) per[key] = round1(sum[key] * f);
      else per[key] = null;
    }
    const totalGrams = (recipe.ingredients || []).reduce((a, i) => a + num(i.grams, 0), 0);
    const gramsPerPortion = Math.max(1, round1(totalGrams / portions));
    return { per, gramsPerPortion, sum };
  }

  function renderRecipesList() {
    const empty = $("#recipesEmpty");
    const ul = $("#recipesList");
    if (!state.recipes.length) {
      empty.hidden = false;
      ul.innerHTML = "";
      return;
    }
    empty.hidden = true;
    ul.innerHTML = state.recipes
      .map((r) => {
        const { per } = recipeTotals(r);
        return `<li class="lib-item recipe-item">
          <div class="lib-main">
            <strong>${escapeHtml(r.name)}</strong>
            <span>${r.ingredients.length} Zutat(en) · ${r.portions} Portion(en) · ${fmt(per.kcal, 0)} kcal / Portion</span>
          </div>
          <div class="lib-actions">
            <button type="button" class="btn btn-sm btn-primary" data-eat-recipe="${r.id}">Rezept essen</button>
            <button type="button" class="btn btn-sm btn-secondary" data-edit-recipe="${r.id}">Bearbeiten</button>
            <button type="button" class="btn btn-sm btn-danger" data-del-recipe="${r.id}">Löschen</button>
          </div>
        </li>`;
      })
      .join("");

    ul.querySelectorAll("[data-eat-recipe]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-eat-recipe");
        const r = state.recipes.find((x) => x.id === id);
        if (!r) return;
        const { per, gramsPerPortion } = recipeTotals(r);
        recipesSheet.close();
        // Convert portion nutrients → per-100g so grams scaling works
        const f = 100 / gramsPerPortion;
        const p100 = {
          kcal: round1(per.kcal * f),
          protein: round1(per.protein * f),
          carbs: round1(per.carbs * f),
          fat: round1(per.fat * f),
          sugar: round1(per.sugar * f),
          satFat: round1(per.satFat * f),
          fiber: round1(per.fiber * f),
          salt: round2(per.salt * f),
        };
        for (const { key } of PHASE_B) {
          p100[key] = per[key] != null ? round1(per[key] * f) : null;
        }
        openPreview({
          source: "recipe",
          recipeId: r.id,
          name: r.name,
          ...p100,
          grams: gramsPerPortion,
        });
      });
    });
    ul.querySelectorAll("[data-edit-recipe]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-edit-recipe");
        openRecipeEditor(id);
      });
    });
    ul.querySelectorAll("[data-del-recipe]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-del-recipe");
        state.recipes = state.recipes.filter((r) => r.id !== id);
        saveState();
        toast("Rezept gelöscht");
        renderRecipesList();
      });
    });
  }

  function openRecipeEditor(id) {
    editingRecipeId = id;
    recipeDraftIngredients = [];
    if (id) {
      const r = state.recipes.find((x) => x.id === id);
      if (r) {
        $("#recipeName").value = r.name;
        $("#recipePortions").value = r.portions;
        recipeDraftIngredients = r.ingredients.map((i) => ({ ...i, per100: normalizeNutrients(i.per100) }));
      }
    } else {
      $("#recipeName").value = "";
      $("#recipePortions").value = 1;
    }
    fillRecipeProductSelect();
    renderRecipeIngredients();
    updateRecipePerPortionPreview();
    recipeEditSheet.showModal();
  }

  function fillRecipeProductSelect() {
    const sel = $("#recipeAddProduct");
    sel.innerHTML = `<option value="">— wählen —</option>` +
      state.products.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  }

  function renderRecipeIngredients() {
    const root = $("#recipeIngredients");
    if (!recipeDraftIngredients.length) {
      root.innerHTML = `<p class="calm-note">Noch keine Zutaten.</p>`;
      return;
    }
    root.innerHTML = recipeDraftIngredients
      .map((ing, idx) => `<div class="ing-row">
        <span>${escapeHtml(ing.name)} · ${fmt(ing.grams, 0)} g</span>
        <button type="button" class="btn btn-sm btn-danger" data-rm-ing="${idx}">Entfernen</button>
      </div>`)
      .join("");
    root.querySelectorAll("[data-rm-ing]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-rm-ing"));
        recipeDraftIngredients.splice(idx, 1);
        renderRecipeIngredients();
        updateRecipePerPortionPreview();
      });
    });
  }

  function updateRecipePerPortionPreview() {
    const draft = {
      portions: num($("#recipePortions").value, 1),
      ingredients: recipeDraftIngredients,
    };
    const { per } = recipeTotals(draft);
    $("#recipePerPortionText").textContent =
      `${fmt(per.kcal, 0)} kcal · ${fmt(per.protein, 1)} g P · ${fmt(per.carbs, 1)} g KH · ${fmt(per.fat, 1)} g F · Salz ${fmt(per.salt, 2)} g`;
  }

  $("#recipeAddBtn").addEventListener("click", () => {
    const pid = $("#recipeAddProduct").value;
    if (!pid) {
      toast("Produkt wählen");
      return;
    }
    const p = state.products.find((x) => x.id === pid);
    if (!p) return;
    const grams = Math.max(1, num($("#recipeAddGrams").value, 100));
    recipeDraftIngredients.push({
      productId: p.id,
      name: p.name,
      grams,
      per100: normalizeNutrients(p.per100),
    });
    renderRecipeIngredients();
    updateRecipePerPortionPreview();
  });

  $("#recipePortions").addEventListener("input", updateRecipePerPortionPreview);

  $("#recipeEditForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!recipeDraftIngredients.length) {
      toast("Mindestens eine Zutat nötig");
      return;
    }
    const name = $("#recipeName").value.trim() || "Rezept";
    const portions = Math.max(1, num($("#recipePortions").value, 1));
    const payload = {
      id: editingRecipeId || uid(),
      name,
      portions,
      ingredients: recipeDraftIngredients.map((i) => ({
        productId: i.productId,
        name: i.name,
        grams: i.grams,
        per100: normalizeNutrients(i.per100),
      })),
      createdAt: new Date().toISOString(),
    };
    if (editingRecipeId) {
      const idx = state.recipes.findIndex((r) => r.id === editingRecipeId);
      if (idx >= 0) state.recipes[idx] = { ...state.recipes[idx], ...payload, createdAt: state.recipes[idx].createdAt };
      else state.recipes.unshift(payload);
    } else {
      state.recipes.unshift(payload);
    }
    saveState();
    recipeEditSheet.close();
    toast("Rezept gespeichert");
    renderRecipesList();
    if (!recipesSheet.open) recipesSheet.showModal();
  });

  // —— Init —— BOOT_GUARD
  try {
    fillGoalsForm();
    renderHeute();
    showPanel("heute");
  } catch (err) {
    console.error(err);
    const banner = document.createElement("div");
    banner.setAttribute("role", "alert");
    banner.style.cssText = "position:fixed;left:12px;right:12px;top:12px;z-index:9999;padding:12px 14px;border-radius:12px;background:#331a1a;color:#ff6b6b;font:14px/1.4 system-ui;";
    banner.textContent = "App-Startfehler: " + (err && err.message ? err.message : String(err));
    document.body.prepend(banner);
  }
})();
