import { FACTS, type DocumentText } from "./types";

/**
 * The End-User License Agreement: the license to use the software, set out on its own for reviewers
 * (app directories, integration marketplaces, customers) who ask for one. It supplements the Terms of
 * Service and repeats their liability, law and ending rules by reference rather than restating them, so
 * the two documents can never disagree.
 */
export const EULA: DocumentText = {
  versionId: "eula-2026-11-24",
  kind: "eula",
  lead: `This agreement is the license that lets your business and its people use the ${FACTS.product} software. It supplements the Terms of Service between your business and ${FACTS.entity}.`,
  sections: [
    {
      id: "about-this-agreement",
      heading: "About this agreement",
      blocks: [
        {
          p: `${FACTS.product} (at ${FACTS.site}) is software for running a cleaning company, provided by ${FACTS.entity}, ${FACTS.address}. In this agreement, "${FACTS.product}", "we" and "us" mean ${FACTS.entity}. "You" means the business that signs up. "Authorized users" means the people your business invites to its workspace as Owner, Manager or Office.`,
        },
        {
          p: `This agreement applies together with the [Terms of Service](/terms), the [Privacy Notice](/privacy) and the other documents the Terms refer to. By using ${FACTS.product} under the Terms, you also agree to this agreement. If this agreement and the Terms of Service conflict, the Terms of Service apply, unless this agreement says it applies instead.`,
        },
        {
          p: `If you do not agree to this agreement, do not use ${FACTS.product}.`,
        },
      ],
    },
    {
      id: "license",
      heading: "Your license",
      blocks: [
        {
          p: `While the Terms of Service apply to your business, we grant your business a limited, non-exclusive, non-transferable, non-sublicensable and revocable license to access and use ${FACTS.product}, and to let its authorized users use it, for the internal operations of your business.`,
        },
        {
          p: `The license covers ${FACTS.product} as we provide it: the web application, the pages and links it sends to your customers, cleaners and applicants on your behalf, its documentation, and the updates and new versions we make available. You use ${FACTS.product} as a service we host. You do not receive a copy of its software.`,
        },
        {
          p: "Everything not expressly granted in this agreement is reserved by us. Plans, limits and features available to your business are those of the plan it is on.",
        },
      ],
    },
    {
      id: "authorized-users",
      heading: "Authorized users",
      blocks: [
        {
          p: "Only authorized users may sign in to your workspace, each with their own account. Accounts may not be shared, and an account may not be used by more than one person.",
        },
        {
          p: `Your business is responsible for its authorized users and for everything done through their accounts, as the Terms of Service describe. People your business works with who do not have an account, such as cleaners, applicants and customers who open a link ${FACTS.product} sends, use only that page, and only for its purpose.`,
        },
      ],
    },
    {
      id: "restrictions",
      heading: "What the license does not allow",
      blocks: [
        { p: `Unless we agree otherwise in writing, you must not, and must not let anyone else:` },
        {
          list: [
            `copy, modify, translate or make derivative works of ${FACTS.product} or any part of it;`,
            "reverse engineer, decompile or disassemble it, or try to find its source code, except where the law allows this despite this term;",
            `sell, resell, rent, lease, lend, sublicense or distribute ${FACTS.product}, or use it to provide services to other businesses as a service bureau or on a time-sharing basis;`,
            "scrape, crawl or extract data or content from the service by automated means, other than through the exports, integrations and interfaces we provide;",
            `use ${FACTS.product}, or information about it, to build or help build a product or service that competes with it, or copy its features, design, workflows or wording;`,
            `run or publish benchmarks, performance tests or comparisons of ${FACTS.product} without our written permission;`,
            "get around the service's limits, permissions, billing or security, or probe, overload or disrupt it;",
            "remove or change any notice of ownership, trademark or confidentiality;",
            "use it in breach of the acceptable use rules in the Terms of Service, or of the export and sanctions laws that apply.",
          ],
        },
        {
          p: `If you find a security weakness, report it as the [Security Overview](/security) explains instead of testing or using it.`,
        },
      ],
    },
    {
      id: "your-content-and-output",
      heading: "Your records and what agents produce for you",
      blocks: [
        {
          p: `Your business owns the records it puts into ${FACTS.product}, as the Terms of Service say.`,
        },
        {
          p: `Your business also owns the output ${FACTS.product} produces for its workspace: for example quotes, proposals, messages, job descriptions, summaries, checklists and images made by its agents and features. To the extent we have any rights in that output, we assign them to your business. ${FACTS.product} may produce similar output for other businesses, and those businesses own theirs.`,
        },
        {
          p: `You give us permission to store, process and display your records and output only to provide ${FACTS.product} to you, to keep it secure, and as the [Privacy Notice](/privacy) says. We do not use your business's records or output to train any AI model.`,
        },
        {
          p: "Output can be wrong or incomplete. Review it before you rely on it or send it, as the agent permissions you set allow. Your business is responsible for the output it approves or lets an agent send, as the Terms of Service describe.",
        },
      ],
    },
    {
      id: "our-property-and-feedback",
      heading: "What belongs to us, and feedback",
      blocks: [
        {
          p: `${FACTS.product}, its software, design, models, templates, documentation and other content, and the ${FACTS.product} name and logo, belong to ${FACTS.entity} and its licensors and are protected by law. This agreement does not transfer any ownership of them to you.`,
        },
        {
          p: `If you or your authorized users send us suggestions, ideas or other feedback about ${FACTS.product}, you grant us a perpetual, irrevocable, worldwide, royalty-free license to use, change and build on that feedback for any purpose, without owing you anything. We will not publish your business's name or confidential information with it without your permission.`,
        },
      ],
    },
    {
      id: "third-party-services",
      heading: "Other providers' services",
      blocks: [
        {
          p: `${FACTS.product} can connect to services your business uses, such as Google, Gmail, your texting provider and Stripe. Each of those services is provided by its own company under its own terms, which apply between your business and that company. We are not responsible for them, and a feature that depends on one may change or stop if that service does.`,
        },
        {
          p: `What ${FACTS.product} may read from or do in a connected service is limited to what your business allows when it connects it, and the [Privacy Notice](/privacy) describes how that information is handled. Your business can disconnect a service at any time in Settings.`,
        },
      ],
    },
    {
      id: "mobile-apps",
      heading: "Mobile apps",
      blocks: [
        {
          p: `${FACTS.product} is offered as a web application today. If we offer a mobile app through an app store, this agreement will be updated with the terms that app store requires before the app is available.`,
        },
      ],
    },
    {
      id: "term-and-ending",
      heading: "How long the license lasts",
      blocks: [
        {
          p: "The license starts when your business accepts the Terms of Service and lasts as long as they apply to it. It ends automatically when the Terms of Service end, or when your business's access ends, and it is suspended for as long as access is suspended under the Terms of Service.",
        },
        {
          p: `When the license ends, your business and its authorized users must stop using ${FACTS.product}. Exporting your records before then is described in the Terms of Service and the [Privacy Notice](/privacy). Sections that by their nature should continue, such as restrictions, ownership, feedback and the sections the next part refers to, continue.`,
        },
      ],
    },
    {
      id: "warranty-liability-law",
      heading: "Warranties, liability and governing law",
      blocks: [
        {
          p: `${FACTS.product} is provided "as is" and "as available". The disclaimers, the limitation of liability and the indemnity in the [Terms of Service](/terms) apply to this agreement and to your use of the software as if they were written here. This agreement adds no warranty or commitment to them.`,
        },
        {
          p: `This agreement is governed by the laws of ${FACTS.governingPlace}, and disputes about it are heard in the courts the Terms of Service name.`,
        },
      ],
    },
    {
      id: "changes-and-contact",
      heading: "Changes and contact",
      blocks: [
        {
          p: "When we change this agreement, we publish a new version with a new date, and earlier versions are listed on this page. Changes take effect as the Terms of Service describe for changes to them.",
        },
        {
          p: `Questions about this agreement: [${FACTS.supportEmail}](mailto:${FACTS.supportEmail}). Formal notices: ${FACTS.entity}, ${FACTS.address}.`,
        },
      ],
    },
  ],
};
