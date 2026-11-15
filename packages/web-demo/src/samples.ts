// Synthetic sample documents for the hosted demo. No real personal data: names, addresses,
// emails (example.com/org/net), phone numbers (555-01xx) and card/SSN values are all public
// test specimens. Mirrors repo testdata/ so the demo shows the same redaction as the extension.

export interface Sample {
  id: string;
  label: string;
  text: string;
}

export const SAMPLES: Sample[] = [
  {
    id: "medical-email",
    label: "Medical billing email",
    text: `From: Springfield Family Clinic <billing@example.org>
To: Jane Q. Example <jane.example@example.com>
Date: 11/02/2026
Subject: Balance due for your 10/14/2026 visit

Dear Jane Q. Example,

Our records show an outstanding balance of $245.80 for your visit on 10/14/2026
(claim 2026-0042, provider Dr. Sam Placeholder). Your insurer processed the claim and
applied $112.00 to your deductible.

To pay by card, reply with the last four digits only. Please do not email full card
numbers. We already have the card ending in 1111 on file (4111 1111 1111 1111) and will
charge it on 11/30/2026 unless you call us at (202) 555-0143 before then.

Questions about the visit itself: Dr. Placeholder's nurse line is +1 415-555-0199.
For billing questions, write to billing@example.org and include your account reference.

Patient address on file:
Jane Q. Example
123 Example Street, Apt 4
Springfield, IL 62704

Thank you,
Springfield Family Clinic Billing`,
  },
  {
    id: "tax-notice",
    label: "Tax notice (longer)",
    text: `DEPARTMENT OF EXAMPLE REVENUE
Notice CP-2000-EX    Tax year 2025    Notice date: November 3, 2026

Taxpayer: Sam Placeholder
Mailing address: 456 Sample Avenue, Springfield, OR 97477
Taxpayer identification number (SSN): 078-05-1120
Spouse SSN on file: 123456789

We changed your 2025 return. Our records show income that was not reported:

  Payer: Example Brokerage LLC        Amount: $1,250.00
  Payer: Sample Savings Bank          Amount: $86.17

Proposed balance due: $412.33 (tax $371.00, interest $41.33).

If you agree, pay online or mail a check with this notice. If you pay by card, use
our processor's website; never send card numbers such as 5555 5555 5555 4444 by mail.

If you disagree, call 1-202-555-0177 or write to notices@example.net
within 30 days. Reference number 900-12-3456 is an internal case id, not an SSN.
Invalid examples 000-12-3456 and 123-00-4567 are shown only for training purposes.

Order confirmation 234567890 was received on 10/28/2026.`,
  },
  {
    id: "hr-benefits",
    label: "HR benefits letter",
    text: `Example Corp People Team
Open enrollment confirmation - plan year 2027

Employee: Jane Q. Example
Employee ID: EX-20417
Work email: jane.example@example.com
Personal email: jq.example@example.net
Mobile: (312) 555-0122

Dependents:
  Sam Placeholder (spouse), SSN 123-45-6789
  Alex Placeholder (child), date of birth 04/09/2019

Elections:
  Medical: Example Health PPO, employee + family, $214.50 per paycheck
  Dental: Example Dental Basic, $18.20 per paycheck
  FSA: $1,500.00 for the year

Your FSA debit card ending 4242 (4242 4242 4242 4242) will be mailed to
123 Example Street, Springfield, IL 62704.

If anything above is wrong, contact benefits@example.com or call +1 312 555 0100
before 12/01/2026. Please send updates from jane.example@example.com only.`,
  },
];
