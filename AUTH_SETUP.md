# Gmail Notification Setup (removed)

The Gmail notification feature has been removed from this project.

It used to collect a customer's Gmail address from a "Customer Access" dialog in
the header and forward it through EmailJS. Nothing ever stored or used the
collected addresses, the EmailJS script was never loaded by the page, and its
configuration was left as placeholders, so the feature could not work and only
collected personal data.

The header account button, the sign-in modal and all of its JavaScript have been
removed. The customer account flow now lives in the owner dashboard only; the
public storefront has no customer accounts.

## Contact form

The contact form in the "Contact" section is delivered by Formspree instead. It
is configured in one place, at the top of the inline script in `index.html`:

```js
const CONTACT_FORM_ID = 'FORMSPREE_FORM_ID';
```

Replace `FORMSPREE_FORM_ID` with the id of a real Formspree form to enable it.
While the placeholder value is still in place the form refuses to claim that a
message was sent and tells the customer to call the store instead.

The form id is a public identifier, not a secret. Do not put private API keys or
server secrets in this file.
