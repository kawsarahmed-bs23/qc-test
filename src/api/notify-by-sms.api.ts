import { DispatchContactApi, type HostAnswer, type UserEditArea } from '@api/dispatch-contact.api';

/**
 * QC-936 host API calls on top of the QC-910 ones (sign-in through `api/account/login`, `user-edit` GET/POST): the create
 * model of Manage Users / the Vendor Portal and the role-change options of Manage Users, which carry `notifyBySms` and
 * `showNotifyBySms`.
 */
export class NotifyBySmsApi extends DispatchContactApi {
  userCreate(area: UserEditArea): Promise<HostAnswer<Record<string, unknown>>> {
    return this.get(`/api/${area}/user-create`);
  }

  organisationOptions(role: string): Promise<HostAnswer<Record<string, unknown>>> {
    return this.get(`/api/manageusers/organisation-options/${encodeURIComponent(role)}`);
  }
}
