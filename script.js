const form = document.querySelector("#bookingForm");
const duration = document.querySelector("#duration");
const estimate = document.querySelector("#estimate");
const dateInput = document.querySelector("#date");
const confirmation = document.querySelector("#confirmation");
const confirmationTitle = document.querySelector("#confirmationTitle");
const summaryText = document.querySelector("#summaryText");
const emailLink = document.querySelector("#emailLink");

if (!form) {
  // Booking behaviour only runs on the booking page.
} else {

const hourlyRate = 65;
const packageRates = {
  4: 220,
  8: 390
};

const today = new Date();
today.setHours(0, 0, 0, 0);
dateInput.min = today.toISOString().slice(0, 10);

function studioEstimate(hours) {
  const parsedHours = Number(hours);
  if (!parsedHours) return null;
  return packageRates[parsedHours] || parsedHours * hourlyRate;
}

function updateEstimate() {
  const cost = studioEstimate(duration.value);
  estimate.textContent = cost
    ? `Estimated studio hire: £${cost}. Add-ons are quoted after we review the brief.`
    : "Select a duration to see the studio hire estimate.";
}

function bookingPayload(formData) {
  const addons = formData.getAll("addons");
  const cost = studioEstimate(formData.get("duration"));
  return {
    sessionType: formData.get("sessionType"),
    date: formData.get("date"),
    time: formData.get("time"),
    duration: formData.get("duration"),
    guests: formData.get("guests"),
    addons,
    name: formData.get("name"),
    email: formData.get("email"),
    notes: formData.get("notes").trim(),
    cost
  };
}

function emailBody(payload) {
  return [
    "Hello Laviya Studios,",
    "",
    "I would like to enquire about booking the studio.",
    "",
    `Name: ${payload.name}`,
    `Email: ${payload.email}`,
    `Session type: ${payload.sessionType}`,
    `Preferred date: ${payload.date}`,
    `Preferred time: ${payload.time}`,
    `Duration: ${payload.duration} hours`,
    `Guests: ${payload.guests}`,
    `Add-ons: ${payload.addons.length ? payload.addons.join(", ") : "None selected"}`,
    `Estimated studio hire: £${payload.cost}`,
    "",
    "Brief:",
    payload.notes || "No brief added yet.",
    "",
    "Thank you."
  ].join("\n");
}

function fallbackEmailLink(payload) {
  const subject = encodeURIComponent(`Booking enquiry from ${payload.name}`);
  const body = encodeURIComponent(emailBody(payload));
  return `mailto:bookings@laviyastudios.com?subject=${subject}&body=${body}`;
}

function setSubmitText(button, text) {
  const textNode = [...button.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  if (textNode) textNode.textContent = ` ${text}`;
}

duration.addEventListener("change", updateEstimate);

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!form.reportValidity()) return;

  const payload = bookingPayload(new FormData(form));
  const submitButton = form.querySelector("button[type='submit']");
  const originalButtonText = submitButton.textContent.trim();
  submitButton.disabled = true;
  setSubmitText(submitButton, "Sending request");

  try {
    const response = await fetch("/api/bookings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw new Error(result.error || "We could not send your request. Please try again.");
    }

    confirmationTitle.textContent = "Your request has been received.";
    summaryText.textContent = `${payload.name}, your ${payload.sessionType.toLowerCase()} request for ${payload.date} at ${payload.time} has been received. Studio hire is estimated at £${payload.cost}. We will review it and get back to you.`;
    emailLink.href = "#booking";
    emailLink.textContent = "Send another request";
    confirmation.hidden = false;
    confirmation.scrollIntoView({ behavior: "smooth", block: "start" });
    form.reset();
    updateEstimate();
  } catch (_error) {
    const needsServer = window.location.protocol === "file:";
    confirmationTitle.textContent = "We could not send it online.";
    summaryText.textContent = needsServer
      ? "The online booking system needs the website to be opened through its local server. You can still send this request by email using the button below."
      : "We could not reach the booking system just now. You can still send this request by email using the button below.";
    emailLink.href = fallbackEmailLink(payload);
    emailLink.textContent = "Email us instead";
    confirmation.hidden = false;
    confirmation.scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    submitButton.disabled = false;
    setSubmitText(submitButton, originalButtonText);
  }
});

}