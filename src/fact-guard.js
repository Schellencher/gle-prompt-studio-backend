"use strict";

const PROOF_MODE = "claim-aware-profile-facts-v2";

function clean(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return clean(value)
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(value) {
  return normalize(value).split(" ").filter(Boolean);
}

function approvedFacts(profile) {
  return (Array.isArray(profile?.proofFacts) ? profile.proofFacts : [])
    .filter((fact) => fact && clean(fact.value) && clean(fact.status || "approved") === "approved")
    .map((fact) => ({
      id: clean(fact.id),
      label: clean(fact.label) || "Fact",
      value: clean(fact.value),
      source: clean(fact.source),
      version: Number(fact.version || 1),
    }));
}

function isTitleFact(fact) {
  const label = clean(fact?.label).toLowerCase();
  return /^(produktname|product name|product|produkt|modellname|model name|modell|model|name)$/.test(label);
}

function pickTitle(profile, facts) {
  const titleFact = facts.find(isTitleFact);
  return clean(titleFact?.value || "");
}

function isEnglish(outLang) {
  return clean(outLang).toLowerCase().startsWith("en");
}

function lowerFirst(value) {
  const s = clean(value);
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function deFactPhrase(fact) {
  const label = normalize(fact?.label);
  const value = clean(fact?.value);

  if (/^(anschluss|connector|port|schnittstelle)$/.test(label)) {
    return `einen ${value}-Anschluss`;
  }
  if (/^(lichtfarbe|light color|licht|light)$/.test(label)) {
    if (/licht$/i.test(value)) return lowerFirst(value);
    return `${lowerFirst(value)}es Licht`.replace(/weisses/i, "weißes");
  }
  if (/^(akkulaufzeit|battery life|laufzeit|runtime)$/.test(label)) {
    return `eine Akkulaufzeit von ${value}`;
  }
  if (/^(fassungsvermoegen|capacity|volumen|volume)$/.test(label)) {
    return `ein Fassungsvermögen von ${value}`;
  }
  if (/^(material|werkstoff)$/.test(label)) {
    return `das Material ${value}`;
  }
  if (/^(farbe|color|colour)$/.test(label)) {
    return `die Farbe ${value}`;
  }
  if (/^(preis|price)$/.test(label)) {
    return `einen Preis von ${value}`;
  }
  if (/^(gewicht|weight)$/.test(label)) {
    return `ein Gewicht von ${value}`;
  }
  if (/^(abmessungen|dimensions|groesse|size)$/.test(label)) {
    return `Abmessungen von ${value}`;
  }

  return `${clean(fact.label)}: ${value}`;
}

function enFactPhrase(fact) {
  const label = normalize(fact?.label);
  const value = clean(fact?.value);

  if (/^(anschluss|connector|port|schnittstelle)$/.test(label)) return `a ${value} port`;
  if (/^(lichtfarbe|light color|licht|light)$/.test(label)) return `${lowerFirst(value)} light`;
  if (/^(akkulaufzeit|battery life|laufzeit|runtime)$/.test(label)) return `battery life of ${value}`;
  if (/^(fassungsvermoegen|capacity|volumen|volume)$/.test(label)) return `a capacity of ${value}`;
  if (/^(material|werkstoff)$/.test(label)) return `${value} material`;
  if (/^(farbe|color|colour)$/.test(label)) return `the color ${value}`;
  if (/^(preis|price)$/.test(label)) return `a price of ${value}`;
  if (/^(gewicht|weight)$/.test(label)) return `a weight of ${value}`;
  if (/^(abmessungen|dimensions|groesse|size)$/.test(label)) return `dimensions of ${value}`;

  return `${clean(fact.label)}: ${value}`;
}

function joinPhrases(items, outLang) {
  const list = items.map(clean).filter(Boolean);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  const conjunction = isEnglish(outLang) ? " and " : " und ";
  if (list.length === 2) return `${list[0]}${conjunction}${list[1]}`;
  return `${list.slice(0, -1).join(", ")}${conjunction}${list[list.length - 1]}`;
}

function buildNaturalFactOutput(profile, { outLang = "DE" } = {}) {
  const facts = approvedFacts(profile);
  if (!facts.length) return "";

  const title = pickTitle(profile, facts);
  const { bodyFacts } = bodyFactsFor(profile, facts);
  const phraseFn = isEnglish(outLang) ? enFactPhrase : deFactPhrase;
  const summary = joinPhrases(bodyFacts.map(phraseFn), outLang);
  const headline = title || (isEnglish(outLang) ? "Product overview" : "Produkt im Überblick");
  const lines = [headline, ""];

  if (summary) {
    lines.push(isEnglish(outLang)
      ? `${title || "The product"} offers ${summary}.`
      : `${title || "Das Produkt"} bietet ${summary}.`);
  }

  lines.push("", title
    ? (isEnglish(outLang) ? `View ${title} details.` : `Details zu ${title} ansehen.`)
    : (isEnglish(outLang) ? "View details." : "Details ansehen."));

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}


function capitalizeFirst(value) {
  const s = clean(value);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function deLandingBullet(fact) {
  const label = normalize(fact?.label);
  const value = clean(fact?.value);

  if (/^(anschluss|connector|port|schnittstelle)$/.test(label)) return `${value}-Anschluss`;
  if (/^(lichtfarbe|light color|licht|light)$/.test(label)) return `${capitalizeFirst(value)}es Licht`;
  if (/^(akkulaufzeit|battery life|laufzeit|runtime)$/.test(label)) return `Akkulaufzeit ${value}`;
  if (/^(fassungsvermoegen|capacity|volumen|volume)$/.test(label)) return `Fassungsvermögen ${value}`;
  if (/^(material|werkstoff)$/.test(label)) return `Material: ${value}`;
  if (/^(farbe|color|colour)$/.test(label)) return `Farbe: ${value}`;
  if (/^(preis|price)$/.test(label)) return `Preis: ${value}`;
  if (/^(gewicht|weight)$/.test(label)) return `Gewicht: ${value}`;
  if (/^(abmessungen|dimensions|groesse|size)$/.test(label)) return `Abmessungen: ${value}`;

  return `${clean(fact.label)}: ${value}`;
}

function enLandingBullet(fact) {
  const label = normalize(fact?.label);
  const value = clean(fact?.value);

  if (/^(anschluss|connector|port|schnittstelle)$/.test(label)) return `${value} port`;
  if (/^(lichtfarbe|light color|licht|light)$/.test(label)) return `${capitalizeFirst(value)} light`;
  if (/^(akkulaufzeit|battery life|laufzeit|runtime)$/.test(label)) return `Battery life ${value}`;
  if (/^(fassungsvermoegen|capacity|volumen|volume)$/.test(label)) return `Capacity ${value}`;
  if (/^(material|werkstoff)$/.test(label)) return `Material: ${value}`;
  if (/^(farbe|color|colour)$/.test(label)) return `Color: ${value}`;
  if (/^(preis|price)$/.test(label)) return `Price: ${value}`;
  if (/^(gewicht|weight)$/.test(label)) return `Weight: ${value}`;
  if (/^(abmessungen|dimensions|groesse|size)$/.test(label)) return `Dimensions: ${value}`;

  return `${clean(fact.label)}: ${value}`;
}

function deFaqQuestion(fact, title) {
  const label = normalize(fact?.label);
  const subject = title || "das Produkt";

  if (/^(anschluss|connector|port|schnittstelle)$/.test(label)) return `Welchen Anschluss hat ${subject}?`;
  if (/^(lichtfarbe|light color|licht|light)$/.test(label)) return `Welche Lichtfarbe hat ${subject}?`;
  if (/^(akkulaufzeit|battery life|laufzeit|runtime)$/.test(label)) return "Wie lange beträgt die Akkulaufzeit?";
  if (/^(fassungsvermoegen|capacity|volumen|volume)$/.test(label)) return `Welches Fassungsvermögen hat ${subject}?`;
  if (/^(material|werkstoff)$/.test(label)) return `Aus welchem Material besteht ${subject}?`;
  if (/^(farbe|color|colour)$/.test(label)) return `Welche Farbe hat ${subject}?`;
  if (/^(preis|price)$/.test(label)) return "Wie hoch ist der Preis?";
  if (/^(gewicht|weight)$/.test(label)) return "Wie hoch ist das Gewicht?";
  if (/^(abmessungen|dimensions|groesse|size)$/.test(label)) return `Welche Abmessungen hat ${subject}?`;

  return `Welche Angabe gilt für ${clean(fact.label)}?`;
}

function enFaqQuestion(fact, title) {
  const label = normalize(fact?.label);
  const subject = title || "the product";

  if (/^(anschluss|connector|port|schnittstelle)$/.test(label)) return `Which port does ${subject} use?`;
  if (/^(lichtfarbe|light color|licht|light)$/.test(label)) return `What light color does ${subject} have?`;
  if (/^(akkulaufzeit|battery life|laufzeit|runtime)$/.test(label)) return "What is the battery life?";
  if (/^(fassungsvermoegen|capacity|volumen|volume)$/.test(label)) return `What capacity does ${subject} have?`;
  if (/^(material|werkstoff)$/.test(label)) return `What material is ${subject} made from?`;
  if (/^(farbe|color|colour)$/.test(label)) return `What color is ${subject}?`;
  if (/^(preis|price)$/.test(label)) return "What is the price?";
  if (/^(gewicht|weight)$/.test(label)) return "What is the weight?";
  if (/^(abmessungen|dimensions|groesse|size)$/.test(label)) return `What are the dimensions of ${subject}?`;

  return `What is the ${clean(fact.label)}?`;
}

function buildLandingFactOutput(profile, { outLang = "DE" } = {}) {
  const facts = approvedFacts(profile);
  if (!facts.length) return "";

  const title = pickTitle(profile, facts);
  const headline = title || (isEnglish(outLang) ? "Product details" : "Produktdetails");
  const { bodyFacts } = bodyFactsFor(profile, facts);
  const phraseFn = isEnglish(outLang) ? enFactPhrase : deFactPhrase;
  const bulletFn = isEnglish(outLang) ? enLandingBullet : deLandingBullet;
  const faqQuestionFn = isEnglish(outLang) ? enFaqQuestion : deFaqQuestion;
  const summary = joinPhrases(bodyFacts.map(phraseFn), outLang);
  const lines = [headline, ""];

  if (summary) {
    lines.push(isEnglish(outLang)
      ? `${title || "The product"} offers ${summary}.`
      : `${title || "Das Produkt"} bietet ${summary}.`, "");
  }

  lines.push(isEnglish(outLang) ? "Product details" : "Produktdetails");
  for (const fact of bodyFacts) lines.push(`• ${bulletFn(fact)}`);

  lines.push("", title
    ? (isEnglish(outLang) ? `View ${title} in detail.` : `${title} im Detail ansehen.`)
    : (isEnglish(outLang) ? "View details." : "Details ansehen."), "", isEnglish(outLang) ? "Frequently asked questions" : "Häufige Fragen");

  for (const fact of bodyFacts.slice(0, 3)) {
    lines.push(faqQuestionFn(fact, title), `${capitalizeFirst(fact.value)}.`, "");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}


function factLabelValue(fact) {
  return `${clean(fact?.label)}: ${clean(fact?.value)}`.trim();
}

function bodyFactsFor(profile, facts) {
  const titleFact = facts.find(isTitleFact) || null;
  const bodyFacts = titleFact ? facts.filter((fact) => fact.id !== titleFact.id) : facts;
  return { titleFact, bodyFacts: bodyFacts.length ? bodyFacts : facts };
}

function cycleFacts(facts, count) {
  const source = Array.isArray(facts) ? facts.filter(Boolean) : [];
  if (!source.length || count <= 0) return [];
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(source[i % source.length]);
  return out;
}

function deFactSentence(fact, title = "") {
  const label = normalize(fact?.label);
  const value = clean(fact?.value);
  const subject = title || "Das Produkt";

  if (/^(anschluss|connector|port|schnittstelle)$/.test(label)) return `${subject} hat einen ${value}-Anschluss.`;
  if (/^(lichtfarbe|light color|licht|light)$/.test(label)) return `Die Lichtfarbe ist ${value}.`;
  if (/^(akkulaufzeit|battery life|laufzeit|runtime)$/.test(label)) return `Die Akkulaufzeit beträgt ${value}.`;
  if (/^(fassungsvermoegen|capacity|volumen|volume)$/.test(label)) return `Das Fassungsvermögen beträgt ${value}.`;
  if (/^(material|werkstoff)$/.test(label)) return `Das Material ist ${value}.`;
  if (/^(farbe|color|colour)$/.test(label)) return `Die Farbe ist ${value}.`;
  if (/^(preis|price)$/.test(label)) return `Der Preis beträgt ${value}.`;
  if (/^(gewicht|weight)$/.test(label)) return `Das Gewicht beträgt ${value}.`;
  if (/^(abmessungen|dimensions|groesse|size)$/.test(label)) return `Die Abmessungen sind ${value}.`;
  return `${clean(fact.label)}: ${value}.`;
}

function enFactSentence(fact, title = "") {
  const label = normalize(fact?.label);
  const value = clean(fact?.value);
  const subject = title || "The product";

  if (/^(anschluss|connector|port|schnittstelle)$/.test(label)) return `${subject} has a ${value} port.`;
  if (/^(lichtfarbe|light color|licht|light)$/.test(label)) return `The light color is ${value}.`;
  if (/^(akkulaufzeit|battery life|laufzeit|runtime)$/.test(label)) return `Battery life is ${value}.`;
  if (/^(fassungsvermoegen|capacity|volumen|volume)$/.test(label)) return `Capacity is ${value}.`;
  if (/^(material|werkstoff)$/.test(label)) return `The material is ${value}.`;
  if (/^(farbe|color|colour)$/.test(label)) return `The color is ${value}.`;
  if (/^(preis|price)$/.test(label)) return `The price is ${value}.`;
  if (/^(gewicht|weight)$/.test(label)) return `The weight is ${value}.`;
  if (/^(abmessungen|dimensions|groesse|size)$/.test(label)) return `The dimensions are ${value}.`;
  return `${clean(fact.label)}: ${value}.`;
}

function buildSocialFactOutput(profile, { outLang = "DE" } = {}) {
  const facts = approvedFacts(profile);
  if (!facts.length) return "";
  const title = pickTitle(profile, facts);
  const { bodyFacts } = bodyFactsFor(profile, facts);
  const bulletFn = isEnglish(outLang) ? enLandingBullet : deLandingBullet;
  const bullets = cycleFacts(bodyFacts, 3);

  const lines = [
    title
      ? (isEnglish(outLang) ? `${title} in three facts.` : `${title} in drei Fakten.`)
      : (isEnglish(outLang) ? "Three product facts." : "Drei Produktfakten."),
    title
      ? (isEnglish(outLang) ? "Product details, straight to the point." : "Produktdetails, direkt auf den Punkt.")
      : (isEnglish(outLang) ? "Product details, straight to the point." : "Produktdetails, direkt auf den Punkt."),
  ];

  for (const fact of bullets) lines.push(`• ${bulletFn(fact)}`);

  lines.push(isEnglish(outLang)
    ? "Which point interests you most?"
    : "Welcher Punkt interessiert dich am meisten?");
  lines.push(title
    ? (isEnglish(outLang) ? `View ${title} details.` : `Details zu ${title} ansehen.`)
    : (isEnglish(outLang) ? "View details." : "Details ansehen."));

  return lines.join("\n").trim();
}

function buildLinkedInFactOutput(profile, { outLang = "DE" } = {}) {
  const facts = approvedFacts(profile);
  if (!facts.length) return "";
  const title = pickTitle(profile, facts);
  const { bodyFacts } = bodyFactsFor(profile, facts);
  const bulletFn = isEnglish(outLang) ? enLandingBullet : deLandingBullet;

  const lines = [
    title
      ? (isEnglish(outLang) ? `${title} — product details, concise` : `${title} – Produktdetails auf den Punkt`)
      : (isEnglish(outLang) ? "Product details, concise" : "Produktdetails auf den Punkt"),
    "",
    title
      ? (isEnglish(outLang) ? `The key details for ${title}:` : `Die wichtigsten Angaben zu ${title}:`)
      : (isEnglish(outLang) ? "The key product details:" : "Die wichtigsten Produktangaben:"),
  ];

  for (const fact of bodyFacts) lines.push(`• ${bulletFn(fact)}`);

  lines.push("", isEnglish(outLang)
    ? "Which of these details is most relevant to your decision?"
    : "Welche dieser Angaben ist für deine Entscheidung besonders relevant?");

  lines.push("", title
    ? (isEnglish(outLang) ? `View ${title} details.` : `Details zu ${title} ansehen.`)
    : (isEnglish(outLang) ? "View details." : "Details ansehen."));

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildEmailFactOutput(profile, { outLang = "DE" } = {}) {
  const facts = approvedFacts(profile);
  if (!facts.length) return "";
  const title = pickTitle(profile, facts);
  const { bodyFacts } = bodyFactsFor(profile, facts);
  const bulletFn = isEnglish(outLang) ? enLandingBullet : deLandingBullet;

  const lines = [
    `${isEnglish(outLang) ? "Subject" : "Betreff"}: ${title || (isEnglish(outLang) ? "Product details" : "Produktdetails")} – ${isEnglish(outLang) ? "key details" : "Produktdetails auf den Punkt"}`,
    "",
    isEnglish(outLang) ? "Hello," : "Hallo,",
    "",
    title
      ? (isEnglish(outLang) ? `The key product details for ${title}:` : `die wichtigsten Produktdetails zu ${title} im Überblick:`)
      : (isEnglish(outLang) ? "The key product details:" : "die wichtigsten Produktdetails im Überblick:"),
    "",
  ];

  for (const fact of bodyFacts) lines.push(`• ${bulletFn(fact)}`);

  lines.push("", title
    ? (isEnglish(outLang) ? `View ${title} details.` : `Details zu ${title} ansehen.`)
    : (isEnglish(outLang) ? "View details." : "Details ansehen."), "", isEnglish(outLang) ? "Best regards" : "Viele Grüße");

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildBlogFactOutput(profile, { outLang = "DE" } = {}) {
  const facts = approvedFacts(profile);
  if (!facts.length) return "";
  const title = pickTitle(profile, facts);
  const { bodyFacts } = bodyFactsFor(profile, facts);
  const sentenceFn = isEnglish(outLang) ? enFactSentence : deFactSentence;
  const first = bodyFacts[0] || null;
  const second = bodyFacts[1] || null;
  const rest = bodyFacts.slice(2);

  const lines = [
    title
      ? (isEnglish(outLang) ? `${title}: product details explained concisely` : `${title}: Produktdetails kurz erklärt`)
      : (isEnglish(outLang) ? "Product details explained concisely" : "Produktdetails kurz erklärt"),
    "",
  ];

  if (first) {
    const firstParagraph = [sentenceFn(first, title), second ? sentenceFn(second, title) : ""]
      .filter(Boolean)
      .join(" ");
    lines.push(firstParagraph, "");
  }

  for (const fact of rest) lines.push(sentenceFn(fact, title), "");

  lines.push(isEnglish(outLang) ? "Conclusion" : "Fazit");
  lines.push(title
    ? (isEnglish(outLang)
      ? `The key product details for ${title} are now briefly summarized.`
      : `Die wichtigsten Produktdetails zu ${title} sind damit kurz zusammengefasst.`)
    : (isEnglish(outLang)
      ? "The key product details are now briefly summarized."
      : "Die wichtigsten Produktdetails sind damit kurz zusammengefasst."));

  lines.push("", title
    ? (isEnglish(outLang) ? `View ${title} details.` : `Details zu ${title} ansehen.`)
    : (isEnglish(outLang) ? "View details." : "Details ansehen."));

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildShortVideoFactOutput(profile, { outLang = "DE" } = {}) {
  const facts = approvedFacts(profile);
  if (!facts.length) return "";
  const title = pickTitle(profile, facts);
  const { bodyFacts } = bodyFactsFor(profile, facts);
  const sceneFacts = cycleFacts(bodyFacts, 3);
  const sentenceFn = isEnglish(outLang) ? enFactSentence : deFactSentence;
  const bulletFn = isEnglish(outLang) ? enLandingBullet : deLandingBullet;
  const subject = title || (isEnglish(outLang) ? "the product" : "das Produkt");
  const lines = [];

  if (isEnglish(outLang)) {
    lines.push("HOOK · 0–2 SEC.");
    lines.push(`Visual: ${title || "Product"} in focus.`);
    lines.push(`Overlay: ${title || "Product"}`);
    lines.push(`Voiceover: ${title ? `${title}, briefly introduced.` : "Product details, briefly introduced."}`);
  } else {
    lines.push("HOOK · 0–2 SEK.");
    lines.push(`Bild: ${title || "Produkt"} im Fokus.`);
    lines.push(`Einblendung: ${title || "Produkt"}`);
    lines.push(`Sprecher: ${title ? `${title} kurz vorgestellt.` : "Produktdetails kurz vorgestellt."}`);
  }

  sceneFacts.forEach((fact, index) => {
    const start = 2 + (index * 3);
    const end = start + 3;
    lines.push("", `${isEnglish(outLang) ? "SCENE" : "SZENE"} ${index + 1} · ${start}–${end} ${isEnglish(outLang) ? "SEC." : "SEK."}`);

    const label = normalize(fact?.label);
    let visual;
    if (/^(anschluss|connector|port|schnittstelle)$/.test(label)) {
      visual = isEnglish(outLang) ? `${bulletFn(fact)} close-up` : `${bulletFn(fact)} in Nahaufnahme`;
    } else if (/^(lichtfarbe|light color|licht|light)$/.test(label)) {
      visual = isEnglish(outLang) ? `${bulletFn(fact)} in focus` : `${bulletFn(fact)} im Fokus`;
    } else {
      visual = title || bulletFn(fact);
    }

    const overlay = /^(anschluss|connector|port|schnittstelle)$/.test(label)
      ? clean(fact.value)
      : /^(lichtfarbe|light color|licht|light)$/.test(label)
        ? capitalizeFirst(fact.value)
        : /^(akkulaufzeit|battery life|laufzeit|runtime)$/.test(label)
          ? capitalizeFirst(fact.value)
          : bulletFn(fact);

    lines.push(`${isEnglish(outLang) ? "Visual" : "Bild"}: ${visual}.`);
    lines.push(`${isEnglish(outLang) ? "Overlay" : "Einblendung"}: ${overlay}`);
    lines.push(`${isEnglish(outLang) ? "Voiceover" : "Sprecher"}: ${sentenceFn(fact, title)}`);
  });

  lines.push("", `OUTRO · 11–13 ${isEnglish(outLang) ? "SEC." : "SEK."}`);
  lines.push(`${isEnglish(outLang) ? "Visual" : "Bild"}: ${subject}.`);
  lines.push(`${isEnglish(outLang) ? "Overlay" : "Einblendung"}: ${isEnglish(outLang) ? "View details" : "Details ansehen"}`);

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Kept as a compatibility export for tests/tools that still reference the v1 name.
function buildFactOnlyOutput(profile, options = {}) {
  return buildNaturalFactOutput(profile, options);
}

const SAFE_GLUE = new Set([
  // DE grammatical glue / neutral verbs
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer",
  "und", "oder", "mit", "von", "zu", "bis", "fuer", "im", "in", "am", "an", "auf", "als",
  "ist", "sind", "hat", "haben", "bietet", "bieten", "verfuegt", "verfuegen", "ueber",
  "umfasst", "enthalten", "enthaelt", "betragt", "betraegt", "liegt", "bei", "erreicht",
  "produkt", "modell", "details", "ansehen", "freigegeben", "freigegebene", "angaben", "fakten",
  "blick", "ueberblick", "kurz", "zusammengefasst", "betreff", "hallo", "gruesse", "viele",
  "produktdetails", "produktangaben", "sprecher", "szene", "einblendung", "abschluss", "outro", "hook",
  "bei", "stehen", "steht", "diese", "drei", "zentral", "zentrale", "zentralen", "wichtig", "wichtigsten",
  "mittelpunkt", "stelle", "zusammen", "zusammengefasst", "hier", "findest", "du", "mehr", "angaben",
  "produktdaten", "kompakt", "damit", "erklaert", "direkt", "punkt", "interessiert", "nahaufnahme",
  // EN grammatical glue / neutral verbs
  "the", "a", "an", "and", "or", "with", "of", "to", "up", "for", "in", "on", "as",
  "is", "are", "has", "have", "offers", "offer", "features", "feature", "includes", "include",
  "provides", "provide", "reaches", "details", "view", "approved", "facts", "product", "model",
  "glance", "overview", "summary", "subject", "hello", "regards", "best", "scene", "voiceover",
  "productdetails", "product", "hook", "outro", "key", "these", "three", "together", "one", "place",
  "here", "brings", "central", "concise", "concisely", "briefly", "introduced", "straight", "point", "summarized",
  // neutral editorial / production language (not product claims)
  "bild", "visual", "kamera", "fokus", "detail", "details", "kurz", "vorgestellt", "vorstellen",
  "einblendung", "overlay", "sprecher", "voiceover", "fazit", "conclusion", "welches", "dieser", "dir",
  "wichtigsten", "entscheidend", "matters", "most", "you", "which", "in", "brief", "focus",
]);

const CLAIM_RISK_TOKENS = new Set([
  // DE/normalized
  "schnell", "schnelles", "schneller", "schnelle", "schnellladen", "ladezeit", "laden", "aufladen",
  "robust", "robuste", "robuster", "wetterfest", "witterung", "wasserfest", "wasserdicht",
  "ideal", "perfekt", "geeignet", "eignet", "einfach", "einfache", "unkompliziert", "unkomplizierte",
  "angenehm", "angenehme", "behaglich", "behagliche", "atmosphaere", "sicher", "sichere",
  "langlebig", "langlebige", "hochwertig", "premium", "effizient", "effiziente", "leistungsstark",
  "kompakt", "leichte", "leicht", "outdoor", "innenbereich", "aussenbereich", "camping", "wandern",
  "picknick", "notbeleuchtung", "haushalt", "stromquelle", "variiert", "haeufig", "nutzung",
  // EN
  "fast", "quick", "quickly", "rapid", "charging", "charge", "rugged", "robust", "weatherproof",
  "waterproof", "ideal", "perfect", "suitable", "easy", "comfortable", "pleasant", "safe", "durable",
  "premium", "efficient", "powerful", "compact", "lightweight", "outdoor", "indoor", "camping",
  "hiking", "emergency", "household",
]);

function factCorpus(facts) {
  return normalize(facts.flatMap((fact) => [fact.label, fact.value]).join(" "));
}

function significantTokens(value) {
  return tokens(value).filter((token) => token.length >= 3 || /^\d/.test(token));
}

function valueMatchesClaim(claimNorm, fact) {
  const valueNorm = normalize(fact?.value);
  if (!valueNorm) return false;
  if (claimNorm.includes(valueNorm)) return true;

  const vTokens = tokens(fact.value).filter((token) => !SAFE_GLUE.has(token));
  if (!vTokens.length) return false;

  // For short/numeric values (USB-C, 750 ml, 12 Stunden), all significant value
  // tokens must occur. This is conservative: paraphrases that cannot be matched
  // deterministically are sent to review instead of being trusted.
  return vTokens.every((token) => claimNorm.split(" ").includes(token));
}

function isNeutralCta(claimNorm, titleNorm = "") {
  if (/^(details ansehen|mehr erfahren|view details|learn more)$/.test(claimNorm)) return true;
  if (!titleNorm) return false;
  return new Set([
    `details zu ${titleNorm} ansehen`,
    `mehr zu ${titleNorm} erfahren`,
    `view ${titleNorm} details`,
    `learn more about ${titleNorm}`,
  ]).has(claimNorm);
}

function technicalCodes(value) {
  const raw = clean(value).toLowerCase();
  const codes = [];
  for (const match of raw.matchAll(/\busb[\s-]?[a-z0-9]+\b/gi)) {
    codes.push(match[0].replace(/[\s-]+/g, ""));
  }
  for (const match of raw.matchAll(/\bip\s?-?\d{2}\b/gi)) {
    codes.push(match[0].replace(/[\s-]+/g, ""));
  }
  return Array.from(new Set(codes));
}


function isStructuralLine(value) {
  const line = clean(value)
    .replace(/^\d+[.)]\s*/, "")
    .trim();
  return /^(bulletpoints|bullet points|mini[- ]?faq|faq|häufige fragen|haeufige fragen|frequently asked questions|auf einen blick|at a glance|fakten|facts|produktdetails|product details|kurz zusammengefasst|summary|im detail|in detail|in short|hallo|hello|viele gr(?:ü|ue)ße|best regards|fazit|conclusion|abschluss|end)\s*[:,]?$/.test(line.toLowerCase())
    || /^(hook|outro|szene\s*\d+|scene\s*\d+)(?:\s*[·-]\s*\d+\s*[–-]\s*\d+\s*(?:sek\.?|sec\.?|s))?\s*[:,]?$/.test(line.toLowerCase())
    || /^(drei|three) produkt(?:angaben|details) (auf einen blick|at a glance)\.?$/i.test(line)
    || /^(produktdetails|product details),? (direkt auf den punkt|straight to the point)\.?$/i.test(line);
}

function isQuestionLine(value) {
  const line = clean(value)
    .replace(/^\d+[.)]\s*/, "")
    .replace(/^[-•*]+\s*/, "")
    .trim();
  return /^(frage|question)\s*:/i.test(line) || /\?$/.test(line);
}

function stripClaimPrefix(value) {
  return clean(value)
    .replace(/^[-•*]+\s*/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/^(frage|antwort|question|answer|cta(?:[- ]?zeile)?|mini faq|betreff|subject|sprecher|voiceover|einblendung|overlay|bild|visual|kamera|abschluss|szene\s*\d+|scene\s*\d+)\s*:\s*/i, "")
    .trim();
}

function splitClaims(output) {
  const out = [];
  for (const rawLine of clean(output).split(/\r?\n/)) {
    if (isStructuralLine(rawLine) || isQuestionLine(rawLine)) continue;
    const line = stripClaimPrefix(rawLine);
    if (!line || isStructuralLine(line) || isQuestionLine(line)) continue;

    const pieces = line
      .split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ0-9])/)
      .map((part) => clean(part).replace(/[.!?]+$/, ""))
      .filter(Boolean);

    out.push(...(pieces.length ? pieces : [line]));
  }
  return out;
}

function auditClaim(claim, { profile, facts, title }) {
  const text = clean(claim);
  const claimNorm = normalize(text);
  const titleNorm = normalize(title);
  const corpus = factCorpus(facts);
  const corpusTokens = new Set(tokens(corpus));

  if (!claimNorm) {
    return { text, supported: true, reason: "empty", matchedFactIds: [] };
  }
  if (claimNorm === titleNorm || isNeutralCta(claimNorm, titleNorm)) {
    const titleFact = facts.find(isTitleFact);
    return {
      text,
      supported: true,
      reason: claimNorm === titleNorm ? "title" : "neutral_cta",
      matchedFactIds: titleFact && claimNorm === titleNorm ? [titleFact.id] : [],
    };
  }

  const matchedFacts = facts.filter((fact) => valueMatchesClaim(claimNorm, fact));
  const matchedFactIds = matchedFacts.map((fact) => fact.id);

  const claimNumbers = claimNorm.match(/\b\d+(?:[.,]\d+)?\b/g) || [];
  const corpusNumbers = new Set(corpus.match(/\b\d+(?:[.,]\d+)?\b/g) || []);
  const unsupportedNumbers = claimNumbers.filter((number) => !corpusNumbers.has(number));

  const approvedTechnicalCodes = new Set(
    facts.flatMap((fact) => technicalCodes(`${fact.label} ${fact.value}`)),
  );
  const unsupportedTechnicalCodes = technicalCodes(text).filter(
    (code) => !approvedTechnicalCodes.has(code),
  );

  const riskTokens = significantTokens(claimNorm).filter(
    (token) => CLAIM_RISK_TOKENS.has(token) && !corpusTokens.has(token),
  );

  const novelTokens = significantTokens(claimNorm).filter((token) => {
    if (corpusTokens.has(token) || SAFE_GLUE.has(token)) return false;
    if (/^\d/.test(token)) return false;
    // Do not flag morphology that directly contains/is contained by an approved token.
    for (const approved of corpusTokens) {
      if (approved.length >= 4 && (token.startsWith(approved) || approved.startsWith(token))) {
        return false;
      }
    }
    return true;
  });

  let supported = matchedFacts.length > 0;
  let reason = supported ? "matched_approved_fact" : "no_approved_fact_match";

  if (unsupportedTechnicalCodes.length) {
    supported = false;
    reason = "unsupported_technical_code";
  } else if (unsupportedNumbers.length) {
    supported = false;
    reason = "unsupported_number";
  } else if (riskTokens.length) {
    supported = false;
    reason = "unsupported_claim_term";
  } else if (novelTokens.length > 0) {
    supported = false;
    reason = "unsupported_claim_language";
  }

  return {
    text,
    supported,
    reason,
    matchedFactIds,
    unsupportedNumbers,
    unsupportedTechnicalCodes,
    unsupportedTokens: Array.from(new Set([...riskTokens, ...novelTokens])).slice(0, 12),
  };
}

function auditOutputAgainstFacts(output, profile) {
  const facts = approvedFacts(profile);
  const title = pickTitle(profile, facts);
  const claims = splitClaims(output);
  const claimMap = claims.map((claim) => auditClaim(claim, { profile, facts, title }));
  const rejectedClaims = claimMap.filter((entry) => !entry.supported);
  const verifiedClaims = claimMap.filter((entry) => entry.supported);
  const matchedFactIds = Array.from(
    new Set(verifiedClaims.flatMap((entry) => entry.matchedFactIds || []).filter(Boolean)),
  );

  return {
    claimMap,
    claimCount: claimMap.length,
    verifiedClaimCount: verifiedClaims.length,
    rejectedClaimCount: rejectedClaims.length,
    rejectedClaims,
    matchedFactIds,
    verifiedFactCount: matchedFactIds.length,
    completeFactCoverage: facts.every((fact) => matchedFactIds.includes(fact.id)),
  };
}

function baseProof(profile, facts) {
  return {
    mode: PROOF_MODE,
    profileId: clean(profile?.id) || null,
    profileVersion: profile ? Number(profile.version || 1) : null,
    factCount: facts.length,
    approvedFactIds: facts.map((fact) => fact.id),
    factVersions: facts.map((fact) => ({ id: fact.id, version: fact.version })),
    worldTruthVerified: false,
  };
}

function resolveUseCaseScope({
  isProductDescription,
  isLandingPage,
  isSocial,
  isLinkedInPost,
  isEmailPost,
  isBlogArticle,
  isShortVideoScript,
} = {}) {
  // Explicit use-case flags take precedence over the broad product-description detector.
  if (isLandingPage) return "landingpage_ad_copy";
  if (isSocial) return "social_media_post";
  if (isLinkedInPost) return "linkedin_post";
  if (isEmailPost) return "email";
  if (isBlogArticle) return "blog_article";
  if (isShortVideoScript) return "short_video_script";
  if (isProductDescription) return "product_description";
  return "";
}

function buildSafeOutputForScope(useCaseScope, profile, { outLang = "DE" } = {}) {
  switch (useCaseScope) {
    case "landingpage_ad_copy":
      return buildLandingFactOutput(profile, { outLang });
    case "social_media_post":
      return buildSocialFactOutput(profile, { outLang });
    case "linkedin_post":
      return buildLinkedInFactOutput(profile, { outLang });
    case "email":
      return buildEmailFactOutput(profile, { outLang });
    case "blog_article":
      return buildBlogFactOutput(profile, { outLang });
    case "short_video_script":
      return buildShortVideoFactOutput(profile, { outLang });
    case "product_description":
    default:
      return buildNaturalFactOutput(profile, { outLang });
  }
}

function safeActionForScope(useCaseScope) {
  return {
    landingpage_ad_copy: "safe_landing_rewrite",
    social_media_post: "safe_social_rewrite",
    linkedin_post: "safe_linkedin_rewrite",
    email: "safe_email_rewrite",
    blog_article: "safe_blog_rewrite",
    short_video_script: "safe_video_rewrite",
    product_description: "safe_natural_rewrite",
  }[useCaseScope] || "safe_natural_rewrite";
}

function applyClaimAwareFactGuard({
  output,
  profile,
  isProductDescription,
  isLandingPage,
  isSocial,
  isLinkedInPost,
  isEmailPost,
  isBlogArticle,
  isShortVideoScript,
  outLang,
} = {}) {
  const facts = approvedFacts(profile);
  const base = baseProof(profile, facts);
  const useCaseScope = resolveUseCaseScope({
    isProductDescription,
    isLandingPage,
    isSocial,
    isLinkedInPost,
    isEmailPost,
    isBlogArticle,
    isShortVideoScript,
  });
  const supportedUseCase = !!useCaseScope;

  if (!profile || !supportedUseCase || !facts.length) {
    return {
      output: clean(output),
      proof: {
        ...base,
        status: "NOT_VERIFIED",
        applied: false,
        reason: !profile
          ? "no_profile"
          : !supportedUseCase
            ? "use_case_not_yet_supported"
            : "no_approved_proof_facts",
        verifiedFactCount: 0,
        claimCount: 0,
        verifiedClaimCount: 0,
        rejectedClaimCount: 0,
      },
    };
  }

  const modelAudit = auditOutputAgainstFacts(output, profile);

  if (modelAudit.rejectedClaimCount === 0 && modelAudit.completeFactCoverage) {
    return {
      output: clean(output),
      proof: {
        ...base,
        status: "PASSED",
        applied: true,
        action: "model_output_verified",
        useCaseScope,
        scope: "selected_profile_facts_claim_audit",
        verifiedFactCount: modelAudit.verifiedFactCount,
        matchedFactIds: modelAudit.matchedFactIds,
        claimCount: modelAudit.claimCount,
        verifiedClaimCount: modelAudit.verifiedClaimCount,
        rejectedClaimCount: 0,
        safeOutputApplied: false,
      },
    };
  }

  // Never expose an unverified model draft. SAFE_REWRITE means the delivered final
  // output was rebuilt only from approved Proof Facts in the native use-case format.
  const safeOutput = buildSafeOutputForScope(useCaseScope, profile, { outLang });
  const safeAudit = auditOutputAgainstFacts(safeOutput, profile);
  const reason = modelAudit.rejectedClaimCount > 0
    ? "unsupported_claims_detected"
    : "incomplete_fact_coverage";

  return {
    output: safeOutput,
    proof: {
      ...base,
      status: "SAFE_REWRITE",
      applied: true,
      action: safeActionForScope(useCaseScope),
      useCaseScope,
      humanReviewRequired: false,
      finalOutputVerified: safeAudit.rejectedClaimCount === 0 && safeAudit.completeFactCoverage,
      scope: "selected_profile_facts_claim_audit",
      reason,
      verifiedFactCount: safeAudit.verifiedFactCount,
      matchedFactIds: safeAudit.matchedFactIds,
      claimCount: modelAudit.claimCount,
      verifiedClaimCount: modelAudit.verifiedClaimCount,
      rejectedClaimCount: modelAudit.rejectedClaimCount,
      rejectedClaims: modelAudit.rejectedClaims.slice(0, 8).map((entry) => ({
        text: entry.text.slice(0, 240),
        reason: entry.reason,
        matchedFactIds: entry.matchedFactIds,
        unsupportedTokens: entry.unsupportedTokens,
        unsupportedNumbers: entry.unsupportedNumbers,
        unsupportedTechnicalCodes: entry.unsupportedTechnicalCodes,
      })),
      safeOutputApplied: true,
      safeOutputVerifiedClaimCount: safeAudit.verifiedClaimCount,
      safeOutputRejectedClaimCount: safeAudit.rejectedClaimCount,
    },
  };
}

// Compatibility alias: callers from v1 can transition without a hard break.
function applyStrictProfileFactGuard(args = {}) {
  return applyClaimAwareFactGuard(args);
}

module.exports = {
  PROOF_MODE,
  approvedFacts,
  buildNaturalFactOutput,
  buildLandingFactOutput,
  buildSocialFactOutput,
  buildLinkedInFactOutput,
  buildEmailFactOutput,
  buildBlogFactOutput,
  buildShortVideoFactOutput,
  buildFactOnlyOutput,
  splitClaims,
  auditClaim,
  auditOutputAgainstFacts,
  resolveUseCaseScope,
  buildSafeOutputForScope,
  applyClaimAwareFactGuard,
  applyStrictProfileFactGuard,
};
