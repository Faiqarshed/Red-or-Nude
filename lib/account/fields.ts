// The account API's field rules: the same checks the sign-up and profile forms
// run (lib/admin/validate.ts), so a request that skips the page gets no further.

import { z } from "zod";
import { checkBirthday, checkEmail, checkPersonName } from "@/lib/admin/validate";
import { riyadhDateKey } from "@/lib/time";
import { validationMessages } from "@/lib/validation-messages";

const v = validationMessages.en;

export const emailField = z
  .string()
  .trim()
  .refine((s) => !checkEmail(v, "Email", s, { required: true }), "invalid-email");

export const nameField = z
  .string()
  .trim()
  .refine((s) => !checkPersonName(v, "Name", s), "invalid-name");

/** `YYYY-MM-DD`, what <input type="date"> submits and a `date` column stores. */
export const birthdayField = z
  .string()
  .refine((s) => !checkBirthday(v, "Birthday", s, riyadhDateKey()), "invalid-birthday");
