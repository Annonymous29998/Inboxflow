declare module 'smtp-server' {
  export class SMTPServer {
    constructor(options?: any);
    listen(port: number, host: string, cb?: () => void): void;
    on(event: string, listener: (...args: any[]) => void): this;
    close(cb?: () => void): void;
  }
  export type SMTPServerAuthentication = {
    username?: string;
    password?: string;
    method?: string;
  };
  export type SMTPServerSession = {
    user?: unknown;
    envelope: {
      mailFrom: false | { address: string };
      rcptTo: Array<{ address: string }>;
    };
  };
}

declare module 'mailparser' {
  export function simpleParser(source: any): Promise<{
    from?: { text?: string; value?: Array<{ address?: string }> };
    to?: { value?: Array<{ address?: string }> };
    replyTo?: { text?: string };
    subject?: string;
    html?: string | false;
    text?: string;
  }>;
}

declare module 'qrcode' {
  namespace QRCode {
    function toDataURL(text: string, opts?: any): Promise<string>;
    function toFile(path: string, text: string, opts?: any): Promise<void>;
    function toString(text: string, opts?: any): Promise<string>;
  }
  export = QRCode;
}

declare module 'nodemailer' {
  namespace nodemailer {
    interface Transporter<T = any> {
      sendMail(mailOptions: SendMailOptions): Promise<SentMessageInfo>;
      verify(): Promise<boolean>;
      close?(): void;
      set?(key: string, value: unknown): void;
    }
    interface SendMailOptions {
      from?: string;
      to?: string | string[];
      cc?: string | string[];
      bcc?: string | string[];
      replyTo?: string;
      subject?: string;
      text?: string;
      html?: string;
      attachments?: any[];
      headers?: Record<string, any>;
      [key: string]: any;
    }
    interface SentMessageInfo {
      messageId?: string;
      response?: string;
      accepted?: Array<string | any>;
      rejected?: Array<string | any>;
      pending?: Array<string | any>;
      envelope?: { from?: string; to?: string[] };
      [key: string]: any;
    }
    interface TransportOptions {
      host?: string;
      port?: number;
      secure?: boolean;
      auth?: { user: string; pass: string };
      service?: string;
      ignoreTLS?: boolean;
      requireTLS?: boolean;
      tls?: Record<string, any>;
      [key: string]: any;
    }
    function createTransport(options?: TransportOptions | any, defaults?: any): Transporter;
    function createTestAccount(apiUrl?: string): Promise<any>;
    function getTestMessageUrl(info: any): string | false;
  }
  export = nodemailer;
}
