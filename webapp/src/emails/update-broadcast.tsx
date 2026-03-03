import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

interface UpdateBroadcastEmailProps {
  heading?: string;
  previewText?: string;
  content?: React.ReactNode;
  unsubscribeUrl?: string;
}

export const UpdateBroadcastEmail: React.FC<
  Readonly<UpdateBroadcastEmailProps>
> = ({
  heading = "An update from Magister",
  previewText = "Here's what's new at Magister.",
  content,
  unsubscribeUrl,
}) => (
  <Html>
    <Head>
      <style>
        {`
          @import url('https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@400;500;600&display=swap');
        `}
      </style>
    </Head>
    <Preview>{previewText}</Preview>
    <Body style={main}>
      <Container style={container}>
        {/* ── Logo ── */}
        <Section style={logoSection}>
          <Img
            src="https://magistermarketing.com/magister-logo-white.png"
            width="28"
            height="30"
            alt="Magister"
            style={{ display: "inline-block", verticalAlign: "middle" }}
          />
          <span style={logoText}>MAGISTER</span>
        </Section>

        {/* ── Hero ── */}
        <Section style={heroSection}>
          <Heading style={h1}>{heading}</Heading>
        </Section>

        <Hr style={divider} />

        {/* ── Body ── */}
        <Section style={bodySection}>
          {content || (
            <Text style={bodyText}>
              Update content goes here.
            </Text>
          )}

          {/* ── Sign-off ── */}
          <Text style={signoffText}>Talk soon,</Text>
          <table style={{ borderCollapse: "collapse" as const }}>
            <tbody>
              <tr>
                <td style={{ paddingRight: "12px", verticalAlign: "middle" }}>
                  <Img
                    src="https://magistermarketing.com/corey.jpeg"
                    width="40"
                    height="40"
                    alt="Corey Haines"
                    style={avatar}
                  />
                </td>
                <td style={{ paddingRight: "20px", verticalAlign: "middle" }}>
                  <Text style={signoffName}>Corey Haines</Text>
                </td>
                <td style={{ paddingRight: "12px", verticalAlign: "middle" }}>
                  <Img
                    src="https://magistermarketing.com/elliot.jpeg"
                    width="40"
                    height="40"
                    alt="Elliot Eckholm"
                    style={avatar}
                  />
                </td>
                <td style={{ verticalAlign: "middle" }}>
                  <Text style={signoffName}>Elliot Eckholm</Text>
                </td>
              </tr>
            </tbody>
          </table>
        </Section>

        <Hr style={divider} />

        {/* ── Footer ── */}
        <Section style={footerSection}>
          <Text style={footerLinks}>
            <Link href="https://magistermarketing.com" style={footerLink}>
              Website
            </Link>
            &nbsp;&nbsp;&bull;&nbsp;&nbsp;
            <Link href="mailto:team@magistermarketing.com" style={footerLink}>
              Contact
            </Link>
            &nbsp;&nbsp;&bull;&nbsp;&nbsp;
            <Link href={unsubscribeUrl || "#"} style={footerLink}>
              Unsubscribe
            </Link>
          </Text>
          <Text style={footerText}>
            Magister Marketing &middot; You received this email because you
            joined the waitlist. If you no longer wish to receive these emails,
            click unsubscribe above.
          </Text>
        </Section>
      </Container>
    </Body>
  </Html>
);

// ── Styles ──────────────────────────────────────────────────────────────────

const fontSerif =
  "'Instrument Serif', Georgia, 'Times New Roman', serif";
const fontSans =
  "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const main: React.CSSProperties = {
  backgroundColor: "#000000",
  margin: "0 auto",
  padding: "0",
};

const container: React.CSSProperties = {
  maxWidth: "560px",
  margin: "0 auto",
  padding: "48px 24px",
};

const logoSection: React.CSSProperties = {
  textAlign: "center" as const,
  paddingBottom: "48px",
};

const logoText: React.CSSProperties = {
  fontFamily: fontSans,
  fontSize: "13px",
  fontWeight: 600,
  letterSpacing: "0.12em",
  color: "rgba(255, 255, 255, 0.9)",
  marginLeft: "10px",
  verticalAlign: "middle",
};

const heroSection: React.CSSProperties = {
  textAlign: "center" as const,
  paddingBottom: "32px",
};

const h1: React.CSSProperties = {
  fontFamily: fontSerif,
  fontSize: "48px",
  fontWeight: 400,
  lineHeight: "1.1",
  letterSpacing: "-0.02em",
  color: "#ffffff",
  margin: "0 0 16px",
};

const divider: React.CSSProperties = {
  borderColor: "rgba(255, 255, 255, 0.1)",
  borderTop: "1px solid rgba(255, 255, 255, 0.1)",
  margin: "0",
};

const bodySection: React.CSSProperties = {
  padding: "32px 0",
};

const bodyText: React.CSSProperties = {
  fontFamily: fontSans,
  fontSize: "15px",
  fontWeight: 400,
  lineHeight: "1.7",
  color: "rgba(255, 255, 255, 0.7)",
  margin: "0 0 20px",
};

const signoffText: React.CSSProperties = {
  fontFamily: fontSans,
  fontSize: "15px",
  fontWeight: 400,
  lineHeight: "1.6",
  color: "rgba(255, 255, 255, 0.6)",
  margin: "32px 0 16px",
};

const signoffName: React.CSSProperties = {
  fontFamily: fontSans,
  fontSize: "14px",
  fontWeight: 500,
  color: "rgba(255, 255, 255, 0.7)",
  margin: "0",
};

const avatar: React.CSSProperties = {
  borderRadius: "50%",
  objectFit: "cover" as const,
};

const footerSection: React.CSSProperties = {
  textAlign: "center" as const,
  padding: "32px 0 0",
};

const footerText: React.CSSProperties = {
  fontFamily: fontSans,
  fontSize: "12px",
  fontWeight: 400,
  color: "rgba(255, 255, 255, 0.25)",
  margin: "0 0 8px",
};

const footerLinks: React.CSSProperties = {
  fontFamily: fontSans,
  fontSize: "12px",
  fontWeight: 400,
  color: "rgba(255, 255, 255, 0.25)",
  margin: "0",
};

const footerLink: React.CSSProperties = {
  color: "rgba(255, 255, 255, 0.4)",
  textDecoration: "none",
};

export default UpdateBroadcastEmail;
