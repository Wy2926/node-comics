import {Icon} from '../../icons';

export function SearchSiteIcon({icon}:{icon?:string}){
  return <span className="nc-search-site-icon" aria-hidden="true"><Icon name="globe" size={16}/>{icon&&<img src={icon} alt="" onError={event=>{event.currentTarget.hidden=true;}}/>}</span>;
}
