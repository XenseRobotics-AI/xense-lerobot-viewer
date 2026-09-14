# SMTP smoke test

This directory contains a backend-only SMTP smoke test for QQ Mail and NetEase
163 Mail.

## 1. Get an authorization code

For QQ Mail:

1. Log in to QQ Mail.
2. Open `Settings` -> `Account`.
3. Enable the `POP3/IMAP/SMTP` service.
4. Generate an authorization code in the same section.

For NetEase 163 Mail:

1. Log in to 163 Mail.
2. Open `Settings` -> `POP3/SMTP/IMAP`.
3. Enable SMTP service.
4. Create or copy the authorization code shown by 163 Mail.

The authorization code is the password for third-party mail clients. It is not
the mailbox login password.

## 2. Where to store the authorization code

Do not commit the code into this repository. Workbench stores each provider's code separately with `0700` directory permissions and `0600` file permissions.
For QQ local use, store it in `<LOCAL_DATASET_ROOT>/.xense-viewer/secrets/smtp-qq-authorization-code`:

```bash
umask 077
install -d -m 700 "$LOCAL_DATASET_ROOT/.xense-viewer/secrets"
printf '%s' 'your-qq-mail-authorization-code' > "$LOCAL_DATASET_ROOT/.xense-viewer/secrets/smtp-qq-authorization-code"
```

For 163 local use, store it in `<LOCAL_DATASET_ROOT>/.xense-viewer/secrets/smtp-163-authorization-code`:

```bash
umask 077
install -d -m 700 "$LOCAL_DATASET_ROOT/.xense-viewer/secrets"
printf '%s' 'your-163-mail-authorization-code' > "$LOCAL_DATASET_ROOT/.xense-viewer/secrets/smtp-163-authorization-code"
```

The script can read either `SMTP_PASSWORD` directly or `SMTP_PASSWORD_FILE`.
The Workbench authorization-code editor derives the provider from Sender and writes the corresponding file under `<LOCAL_DATASET_ROOT>/.xense-viewer/secrets/`. The standalone script reads the file named by `SMTP_PASSWORD_FILE`.

## 3. Provider settings

Set `SMTP_PROVIDER` to `qq` or `163`. QQ remains the default for compatibility.
Both providers use implicit TLS on port 465 by default:

| Provider         | `SMTP_PROVIDER` | `SMTP_HOST`    | `SMTP_PORT` | `SMTP_USE_SSL` |
| ---------------- | --------------- | -------------- | ----------- | -------------- |
| QQ Mail          | `qq`            | `smtp.qq.com`  | `465`       | `1`            |
| NetEase 163 Mail | `163`           | `smtp.163.com` | `465`       | `1`            |

## 4. How to set the sender address

Set the sender address to the QQ mailbox you want to use:

- `SMTP_FROM_ADDRESS=sender@qq.com`

For 163, use the complete 163 mailbox address:

- `SMTP_FROM_ADDRESS=operator@163.com`

The recipient, subject, and plain-text/HTML bodies can be passed in the
environment:

- `SMTP_TO_ADDRESS=jay@xenserobotics.com`
- `SMTP_SUBJECT=...`
- `SMTP_TEXT_BODY=...`
- `SMTP_HTML_BODY=...`

Recommended QQ runtime settings:

- `SMTP_PROVIDER=qq`
- `SMTP_HOST=smtp.qq.com`
- `SMTP_PORT=465`
- `SMTP_USE_SSL=1`

Recommended 163 runtime settings:

- `SMTP_PROVIDER=163`
- `SMTP_HOST=smtp.163.com`
- `SMTP_PORT=465`
- `SMTP_USE_SSL=1`

## 5. Run it

```bash
SMTP_PASSWORD_FILE="$LOCAL_DATASET_ROOT/.xense-viewer/secrets/smtp-qq-authorization-code" \
SMTP_PROVIDER=qq \
SMTP_FROM_ADDRESS=sender@qq.com \
SMTP_TO_ADDRESS=jay@xenserobotics.com \
SMTP_SUBJECT='SMTP smoketest' \
SMTP_TEXT_BODY='SMTP smoke test from xense-lerobot-viewer.' \
SMTP_HTML_BODY='<p>SMTP smoke test from xense-lerobot-viewer.</p>' \
SMTP_HOST=smtp.qq.com \
SMTP_PORT=465 \
SMTP_USE_SSL=1 \
python scripts/mail-smoke-test/smtp_smoke_test.py
```

The equivalent 163 command is:

```bash
SMTP_PASSWORD_FILE="$LOCAL_DATASET_ROOT/.xense-viewer/secrets/smtp-163-authorization-code" \
SMTP_PROVIDER=163 \
SMTP_FROM_ADDRESS=operator@163.com \
SMTP_TO_ADDRESS=jay@xenserobotics.com \
SMTP_HOST=smtp.163.com \
SMTP_PORT=465 \
SMTP_USE_SSL=1 \
python scripts/mail-smoke-test/smtp_smoke_test.py
```

The resulting message is `multipart/alternative`: clients that do not render
HTML use the plain-text body.
