export interface VendorCategoryDef {
  name: string;
  fullName: string;
  description: string;
  vendors: string[];
}

export const VENDOR_CATEGORIES: VendorCategoryDef[] = [
  {
    name: 'SIEM',
    fullName: 'Next-Gen AI SIEM',
    description:
      'AI-native SIEM platforms that combine predictive analytics, autonomous investigation, and large-scale telemetry correlation.',
    vendors: [
      'Microsoft Sentinel + Security Copilot',
      'CrowdStrike Falcon Next-Gen SIEM + Charlotte AI',
      'Palo Alto Networks (Cortex XSIAM)',
      'Google Security Operations (Chronicle) + Gemini',
      'Splunk (Cisco) + AI Assistant',
      'Elastic Security + AI Assistant',
      'Exabeam',
      'Fortinet FortiSIEM + FortiAI-Assist',
      'Rapid7 Incident Command (AI-native SIEM)',
      'Anomali',
    ],
  },
  {
    name: 'EDR/XDR',
    fullName: 'Endpoint/Extended Detection and Response',
    description:
      'Endpoint and cross-domain detection platforms using AI-driven behavioral analysis, automated response, and threat lineage modeling.',
    vendors: [
      'CrowdStrike Falcon + Charlotte AI / AgentWorks',
      'SentinelOne Singularity + Purple AI',
      'Microsoft Defender XDR + Security Copilot',
      'Palo Alto Networks Cortex XDR',
      'Trend Micro Vision One + Companion (GenAI)',
      'Wiz Defend (CDR)',
      'Sophos XDR + Sophos AI Assistant',
      'Check Point XDR + Infinity AI Copilot',
      'Illumio Insights',
      'Vectra AI',
    ],
  },
  {
    name: 'SOAR',
    fullName: 'Security Orchestration, Automation and Response (Hyperautomation)',
    description:
      'SOAR platforms that generate and adapt workflows dynamically with AI-driven orchestration and autonomous incident handling.',
    vendors: [
      'Torq',
      'Tines',
      'Palo Alto Cortex XSOAR',
      'Splunk SOAR + Agentic AI',
      'Google SecOps SOAR + Gemini',
      'Swimlane',
      'CrowdStrike Fusion SOAR',
      'Fortinet FortiSOAR + FortiAI',
      'SentinelOne Purple AI Workflows',
      'D3 Security',
    ],
  },
  {
    name: 'IAM/PAM',
    fullName: 'Identity & Access Management / Privileged Access Management',
    description:
      'Identity platforms focused on intelligent access governance, privileged account protection, and identity threat detection and response (ITDR).',
    vendors: [
      'CyberArk CORA AI (PAM/Identity Security)',
      'Okta (Okta AI / Secure AI Agents / ITDR)',
      'SailPoint Atlas',
      'Microsoft Entra + Copilot',
      'Delinea',
      'Silverfort',
      'Zscaler AI Access',
      'Netskope One',
      'BeyondTrust',
      'ServiceNow Now Assist',
    ],
  },
  {
    name: 'Zero Trust',
    fullName: 'Zero Trust Network Access (ZTNA)',
    description:
      'Zero Trust architectures that apply AI-based policy, dynamic segmentation, and continuous trust evaluation for users, apps, and data.',
    vendors: [
      'Zscaler AI Security',
      'Cloudflare One',
      'Netskope One + SkopeAI',
      'Palo Alto Networks Prisma SASE',
      'Illumio',
      'Microsoft Zero Trust Suite',
      'Fortinet Security Fabric',
      'Check Point Infinity',
      'Akamai',
      'Cato Networks',
    ],
  },
  {
    name: 'Threat Intelligence',
    fullName: 'Cyber Threat Intelligence Platforms',
    description:
      'Cyber threat intelligence platforms that transform global telemetry into actionable adversary insights and automated SOC intelligence flows.',
    vendors: [
      'Recorded Future AI (Intelligence Graph + MCP + autonomous ops)',
      'Google Threat Intelligence (Mandiant + Gemini)',
      'CrowdStrike Falcon Intelligence',
      'Flashpoint Ignite + Ignite AI',
      'Microsoft Security Copilot Intel',
      'Anomali Copilot',
      'Palo Alto Unit 42',
      'ThreatConnect',
      'Digital Shadows (ReliaQuest)',
      'ZeroFox',
    ],
  },
  {
    name: 'AI Security',
    fullName: 'AI Security (AISec)',
    description:
      'Security solutions focused on protecting enterprise AI systems, LLM applications, and model supply chains against adversarial attacks.',
    vendors: [
      'OneTrust AI Governance',
      'Wiz AI-APP (AI-SPM)',
      'HiddenLayer',
      'Lasso Security',
      'Zscaler AI Security',
      'Cloudflare AI Prompt Protection',
      'Palo Alto Secure AI by Design',
      'Tenable One AI Exposure',
      'Protect AI',
      'Netskope One AI Security',
    ],
  },
  {
    name: 'Cloud Security',
    fullName: 'Cloud-Native Application Protection Platform (CNAPP)',
    description:
      'CNAPP vendors providing unified cloud posture, workload protection, and runtime threat detection across multi-cloud environments.',
    vendors: [
      'Wiz (Mika/Agents)',
      'Palo Alto Prisma Cloud',
      'Orca Security',
      'Microsoft Defender for Cloud',
      'Google Cloud Security (Gemini)',
      'Sysdig',
      'Aqua Security',
      'Lacework (Fortinet)',
      'Tenable Cloud Security',
      'Uptycs',
    ],
  },
  {
    name: 'RedTeam',
    fullName: 'Adversary Simulation and Automated Red Teaming',
    description:
      'Platforms that continuously emulate adversary behavior to validate controls and expose attack paths before real attackers do.',
    vendors: [
      'Horizon3.ai (NodeZero)',
      'Pentera',
      'Wiz Red Agent',
      'Picus Security',
      'SafeBreach',
      'SentinelOne Purple AI Red Teaming',
      'Zscaler AI Red Teaming',
      'AttackIQ',
      'XM Cyber',
      'Bishop Fox (Cosmos)',
    ],
  },
  {
    name: 'VAPT',
    fullName: 'Vulnerability Assessment and Penetration Testing Management',
    description:
      'Platforms that prioritize vulnerabilities using AI-assisted exposure analytics and combine scanning with continuous validation.',
    vendors: [
      'Tenable (ExposureAI)',
      'Qualys (TruRisk AI)',
      'Rapid7 Incident Command',
      'CrowdStrike CTEM',
      'Palo Alto Precision AI',
      'BreachLock',
      'Detectify',
      'Nucleus Security',
      'Brinqa',
      'Intruder',
    ],
  },
  {
    name: 'GRC',
    fullName: 'Governance, Risk, and Compliance',
    description:
      'GRC platforms that automate controls, evidence collection, and risk workflows for compliance and cyber governance at scale.',
    vendors: [
      'ServiceNow (Now Assist)',
      'Vanta',
      'Drata',
      'OneTrust AI Governance',
      'AuditBoard',
      'LogicGate',
      'Microsoft Security Copilot (Reporting)',
      'MetricStream',
      'Tenable AI Exposure (Governance)',
      '6Click',
    ],
  },
  {
    name: 'Firewall',
    fullName: 'Next-Gen AI Firewall',
    description:
      'Firewall vendors combining network inspection, threat intelligence, and AI-driven prevention from on-prem to cloud-delivered controls.',
    vendors: [
      'Palo Alto Networks',
      'Fortinet (FortiAI-Assist)',
      'Check Point (Quantum Force)',
      'Cloudflare Magic Firewall',
      'Zscaler AI Guardrails',
      'Netskope SASE / FWaaS',
      'Cisco Secure Firewall',
      'Sophos Firewall',
      'Trend Micro Vision One Network',
      'WatchGuard',
    ],
  },
  {
    name: 'DSLM',
    fullName: 'DSLM Cybersecurity',
    description:
      'Domain-specific language models for cybersecurity, focused on security operations, threat intelligence, validation, governance, and AI-native defensive workflows.',
    vendors: [
      'Sec-PaLM / Gemini Sec (Google / DeepMind)',
      'Security Copilot LLM (Microsoft)',
      'Charlotte AI (CrowdStrike)',
      'Falcon LLM (Technology Innovation Institute)',
      'LLM-Security (Anthropic / Claude)',
      'CodeShield AI (Meta / community)',
      'Osiris (IBM Research)',
      'Armis AI Engine (Armis)',
      'SecBERT / SecRoBERTa (Open source / UCSB)',
      'PentestGPT / HackerLLM (Community / HackerOne)',
      'CrystalBall (Palo Alto Networks)',
    ],
  },
];

export const CATEGORY_NAMES = VENDOR_CATEGORIES.map(c => c.name);

export function getCategoryDef(name: string): VendorCategoryDef | undefined {
  return VENDOR_CATEGORIES.find(c => c.name.toLowerCase() === name.toLowerCase());
}
