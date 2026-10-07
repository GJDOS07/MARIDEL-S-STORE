# Gmail Notification Setup

The website now uses a manual Gmail input. It does not use Google OAuth, Google Sign-In, a Google icon, or a password field.

The form calls EmailJS only after a valid address ending in `@gmail.com` is entered. The recipient is configured in the EmailJS template as `gjalcantara24@gmail.com`. No success message is shown when the EmailJS configuration is missing or the request fails.

## Configure EmailJS

1. Create an account at EmailJS and verify the owner email address.
2. Create an email service connected to the mailbox that will send the notification.
3. Create an email template with these values:

   - To email: `gjalcantara24@gmail.com`
   - Subject: `New Customer Gmail Submission`
   - Body:

     ```text
     May customer na naglagay ng kanilang Gmail address sa website.

     Customer Gmail: {{customer_gmail}}
     Petsa/Oras: {{submission_time}}
     ```

4. Copy the EmailJS public key, service ID, and template ID.
5. In `index.html`, replace the three `YOUR_EMAILJS_*` values in `emailjsConfig`.

The EmailJS public key is intended for browser use. Do not put private API keys or server secrets in this file. For stronger control, move the send call to a backend endpoint and keep provider secrets in environment variables.

## Test the notification

1. Serve the folder from a real local web server or deploy it to the authorized EmailJS domain.
2. Open the login form and enter a real address such as `customer@gmail.com`.
3. Click `Continue`.
4. Confirm the success message appears only after EmailJS returns successfully.
5. Check the inbox and spam folder of `gjalcantara24@gmail.com` for `New Customer Gmail Submission`.
6. Test an invalid address such as `customer@yahoo.com`; it must show `Mangyaring maglagay ng valid na Gmail address.` and must not call EmailJS.

The current workspace cannot verify delivery until the owner supplies the EmailJS configuration. Without it, the site truthfully shows `May nangyaring problema. Pakisubukan muli.`.
