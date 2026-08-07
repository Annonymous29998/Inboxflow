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
