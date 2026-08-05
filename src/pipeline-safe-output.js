"use strict";

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeLabel(value) {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isEnglish(outLang) {
  return clean(outLang).toLowerCase().startsWith("en");
}

function approvedFacts(profile) {
  return (Array.isArray(profile?.proofFacts) ? profile.proofFacts : [])
    .filter(
      (fact) =>
        fact &&
        clean(fact.value) &&
        clean(fact.status || "approved").toLowerCase() === "approved",
    )
    .map((fact) => ({
      id: clean(fact.id),
      label: clean(fact.label) || "Fact",
      value: clean(fact.value),
    }));
}

function isTitleFact(fact) {
  return /^(produktname|product name|product|produkt|modellname|model name|modell|model|name)$/.test(
    normalizeLabel(fact?.label),
  );
}

function cycleFacts(facts, count) {
  const source = Array.isArray(facts) ? facts.filter(Boolean) : [];
  if (!source.length) return [];

  const result = [];
  for (let index = 0; index < count; index += 1) {
    result.push(source[index % source.length]);
  }
  return result;
}

function capitalizeFirst(value) {
  const text = clean(value);
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function deBullet(fact) {
  const label = normalizeLabel(fact?.label);
  const value = clean(fact?.value);

  if (/^(anschluss|connector|port|schnittstelle)$/.test(label)) {
    return `${value}-Anschluss`;
  }

  if (/^(lichtfarbe|light color|licht|light)$/.test(label)) {
    return `${capitalizeFirst(value)}es Licht`;
  }

  if (/^(akkulaufzeit|battery life|laufzeit|runtime)$/.test(label)) {
    return `Akkulaufzeit ${value}`;
  }

  return `${clean(fact?.label)}: ${value}`;
}

function enBullet(fact) {
  const label = normalizeLabel(fact?.label);
  const value = clean(fact?.value);

  if (/^(anschluss|connector|port|schnittstelle)$/.test(label)) {
    return `${value} port`;
  }

  if (/^(lichtfarbe|light color|licht|light)$/.test(label)) {
    return `${capitalizeFirst(value)} light`;
  }

  if (/^(akkulaufzeit|battery life|laufzeit|runtime)$/.test(label)) {
    return `Battery life ${value}`;
  }

  return `${clean(fact?.label)}: ${value}`;
}

function deSentence(fact, title) {
  const label = normalizeLabel(fact?.label);
  const value = clean(fact?.value);
  const subject = title || "Das Produkt";

  if (/^(anschluss|connector|port|schnittstelle)$/.test(label)) {
    return `${subject} hat einen ${value}-Anschluss.`;
  }

  if (/^(lichtfarbe|light color|licht|light)$/.test(label)) {
    return `Die Lichtfarbe ist ${value}.`;
  }

  if (/^(akkulaufzeit|battery life|laufzeit|runtime)$/.test(label)) {
    return `Die Akkulaufzeit beträgt ${value}.`;
  }

  return `${clean(fact?.label)}: ${value}.`;
}

function enSentence(fact, title) {
  const label = normalizeLabel(fact?.label);
  const value = clean(fact?.value);
  const subject = title || "The product";

  if (/^(anschluss|connector|port|schnittstelle)$/.test(label)) {
    return `${subject} has a ${value} port.`;
  }

  if (/^(lichtfarbe|light color|licht|light)$/.test(label)) {
    return `The light color is ${value}.`;
  }

  if (/^(akkulaufzeit|battery life|laufzeit|runtime)$/.test(label)) {
    return `Battery life is ${value}.`;
  }

  return `${clean(fact?.label)}: ${value}.`;
}

function buildPipelineSafeOutput({
  step,
  profile,
  outLang = "DE",
} = {}) {
  const facts = approvedFacts(profile);
  if (!facts.length) return "";

  const stepId = clean(step?.id).toLowerCase();
  const english = isEnglish(outLang);
  const titleFact = facts.find(isTitleFact) || null;
  const title = clean(titleFact?.value);
  const bodyFacts = titleFact
    ? facts.filter((fact) => fact.id !== titleFact.id)
    : facts;

  const selectedFacts = cycleFacts(
    bodyFacts.length ? bodyFacts : facts,
    3,
  );

  const bullet = english ? enBullet : deBullet;
  const sentence = english ? enSentence : deSentence;

  if (stepId === "social") {
    return [
      title
        ? english
          ? `${title} in three facts.`
          : `${title} in drei Fakten.`
        : english
          ? "Three product facts."
          : "Drei Produktfakten.",
      english
        ? "Product details, straight to the point."
        : "Produktdetails, direkt auf den Punkt.",
      ...selectedFacts.map((fact) => `• ${bullet(fact)}`),
      english
        ? "Which point interests you most?"
        : "Welcher Punkt interessiert dich am meisten?",
      title
        ? english
          ? `View ${title} details.`
          : `Details zu ${title} ansehen.`
        : english
          ? "View details."
          : "Details ansehen.",
    ].join("\n");
  }

  if (stepId === "linkedin") {
    return [
      title
        ? english
          ? `${title} — product details at a glance`
          : `${title} – Produktangaben im Überblick`
        : english
          ? "Product details at a glance"
          : "Produktangaben im Überblick",
      "",
      title
        ? english
          ? `The key details for ${title}:`
          : `Die wichtigsten Angaben zu ${title}:`
        : english
          ? "The key product details:"
          : "Die wichtigsten Produktangaben:",
      "",
      ...selectedFacts.flatMap((fact) => [
        sentence(fact, title),
        "",
      ]),
      english
        ? "Which of these details is most relevant to your decision?"
        : "Welche dieser Angaben ist für deine Entscheidung besonders relevant?",
      "",
      title
        ? english
          ? `View ${title} details.`
          : `Details zu ${title} ansehen.`
        : english
          ? "View details."
          : "Details ansehen.",
    ]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  if (stepId === "email") {
    const factParagraph = selectedFacts
      .map((fact) => sentence(fact, title))
      .join(" ");

    return [
      `${english ? "Subject" : "Betreff"}: ${
        title || (english ? "Product details" : "Produktdetails")
      } – ${english ? "key details" : "die wichtigsten Angaben"}`,
      "",
      english ? "Hello," : "Hallo,",
      "",
      title
        ? english
          ? `Here are the key product details for ${title}:`
          : `hier sind die wichtigsten Produktdetails zu ${title}:`
        : english
          ? "Here are the key product details:"
          : "hier sind die wichtigsten Produktdetails:",
      "",
      factParagraph,
      "",
      title
        ? english
          ? `View ${title} details.`
          : `Details zu ${title} ansehen.`
        : english
          ? "View details."
          : "Details ansehen.",
      "",
      english ? "Best regards" : "Viele Grüße",
    ].join("\n");
  }

  return "";
}

module.exports = {
  buildPipelineSafeOutput,
};
