// The code's length, on its own so both sides of the client boundary can have
// it. lib/otp.ts is server-only (it reaches the database), and the input box in
// components/OtpInput.tsx has to cap at the same number — a mismatch there
// means a customer typing a code the server will reject as malformed.
export const OTP_LENGTH = 6;
