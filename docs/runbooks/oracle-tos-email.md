# Draft: terms-of-service e-mail to Oracle

Status: **draft only**. Claude does not send it. The developer (Tanmay, account owner) sends it and keeps the reply (PRD R-4, OI-8).

**To:** address to be confirmed by the developer (find the right Oracle contact for acceptable-use or terms questions; Claude has not verified any address).
**From:** the account owner's e-mail.
**Subject:** Question about acceptable use: intentionally vulnerable security training lab on Always Free compute

Hello,

We are three students building VulnMart, an **intentionally vulnerable, flag-based online shop** used as a security training and skills-assessment lab (it follows the OWASP Top 10). Each user gets their own isolated copy (an "instance") of the shop. Users, and recruiters or hiring teams from companies who assess candidates, deliberately attack **their own instance** to find the planted weaknesses and capture flags; the system scores their findings automatically. It will run on two Always Free Ampere A1 compute instances in the India South (Mumbai) region of our own account.

Please note what this means on your network, so that nothing surprises you:
- **Hostile traffic originates from the instance VM.** Attack traffic is aimed at the vulnerable shop containers on one VM (the "labs" VM) and some of the planted weaknesses (for example server-side request forgery and file import) make the shop itself send requests. We limit this with container isolation, but the activity will look like an attack against, and from, that VM.
- The platform (accounts, scoring, database) runs on a **separate VM**; the vulnerable code does not run there.
- No real user data and no real payment data are used inside the lab; all shop data is fake. The platform holds only the accounts of the training users.
- Players are told to attack only their own instance. Attacks on other systems are not part of the exercise and are against our rules.
- We use the Always Free allowance only and will not upgrade to a paid plan.

Our questions:
1. **Is running this intentionally vulnerable training and assessment lab, with users attacking their own isolated instances, acceptable under Oracle's Acceptable Use Policy and the terms for Always Free resources?** Please answer yes or no, and name any condition.
2. Is there anything we should do in advance, such as notifying you of the security testing, or limits on outbound traffic?
3. How should we contact you if an abuse report is raised about this account, so we can respond quickly?

Please reply in writing so that we can keep your answer for our project report.

Thank you,
(Name, account owner)
(Project: VulnMart, college major project)

---
After sending: write the date in `docs/runbooks/oracle-account-and-vms.md` Part F, keep the reply (do not put the e-mail address or account details in the repository), and tell the team in the chat.

## If Oracle does not reply

1. Record the date you sent the e-mail and the date you checked in Part F. Send one polite reminder after 10 working days; keep both messages.
2. Do not read silence as permission. Write "no reply, sent on <date>, reminder on <date>" in the project report as a risk (PRD R-4).
3. Keep the **laptop fallback ready** (architecture 02 section 3: a single machine with Docker and WSL2), tested at least once before the demonstration, so the lab still runs if the account is suspended.
4. Decide with the team (Tanmay, Akshay, Sahil) whether to keep going on Oracle, limit the lab to demonstration use, or move to the laptop fallback or another host; record the decision as an ADR. Do not decide alone.
5. Until a reply arrives, keep the lab closed to outside users (no public invitations) and keep outbound traffic from the labs VM as limited as the isolation work (L-15, L-29) allows.
