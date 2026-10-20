export type EmailResipient = {
  name?: string;
  email: string;
};
export type SendTransactionalEmailType = {
  to: EmailResipient[];
  subject: string;
  htmlContent: string;
};
