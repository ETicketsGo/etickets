/**
 * The support address the platform publishes, in one place for the storefront AND the API.
 *
 * The storefront prints it on the Contact page (through `BUSINESS_DETAILS` in web-kit), and
 * the API mails every Contact and Help form message to it in production. Two copies of an
 * address drift; the day they do, customers are told to write to one mailbox and the forms
 * deliver to another. So both read this constant.
 *
 * It is the Microsoft 365 shared mailbox "ETicketsGo Customer Support".
 */
export const PUBLISHED_SUPPORT_EMAIL = 'support@eticketsgo.com';
