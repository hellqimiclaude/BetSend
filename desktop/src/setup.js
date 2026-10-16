// Kept out of the HTML so the page's own Content-Security-Policy can refuse
// inline scripts, the same way the web app's does.
const form = document.getElementById('form');
const address = document.getElementById('address');
const submit = document.getElementById('submit');
const message = document.getElementById('message');

function say(text, kind) {
  message.textContent = text;
  message.className = `message ${kind ?? ''}`;
}

window.betsend.currentAddress().then((current) => {
  if (current) address.value = current;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const typed = address.value.trim();
  if (!typed) return;

  submit.disabled = true;
  say('Looking for the server...', 'good');

  try {
    const found = await window.betsend.tryAddress(typed);
    if (!found.ok) {
      say(found.error ?? 'Could not reach that address.', 'bad');
      return;
    }
    say(`Found BetSend at ${found.url}`, 'good');
    const used = await window.betsend.useAddress(found.url);
    if (!used.ok) say(used.error ?? 'Could not save that address.', 'bad');
  } catch (err) {
    say(String(err && err.message ? err.message : err), 'bad');
  } finally {
    submit.disabled = false;
  }
});
